#!/usr/bin/env bash
# Root-owned deploy entrypoint. The runner cannot replace this script.
set -euo pipefail
umask 077
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly root=/srv/zride
readonly state=/var/lib/zride
readonly service=zride.service
die() { printf '%s\n' "$*" >&2; exit 1; }
[[ $(id -u) -eq 0 ]] || die 'Run through the configured sudo deployment entrypoint.'
[[ $# -eq 2 ]] || die 'Expected commit SHA and archive SHA256.'
readonly revision=$1
readonly digest=$2
[[ $revision =~ ^[0-9a-f]{40}$ ]] || die 'Invalid commit SHA.'
[[ $digest =~ ^[0-9a-f]{64}$ ]] || die 'Invalid archive SHA256.'
readonly archive="$root/incoming/zride-server-$revision.tar.gz"
readonly release="$root/releases/$revision"
[[ -f $archive && ! -L $archive ]] || die 'Expected a regular archive in the fixed incoming directory.'
[[ $(readlink -f "$archive") == "$archive" ]] || die 'Archive path must not traverse a symlink.'
actual=$(sha256sum "$archive" | cut -d ' ' -f 1)
[[ $actual == "$digest" ]] || die 'Archive checksum mismatch.'
[[ ! -e $root/current || -L $root/current ]] || die 'Current release must be a symlink.'
exec 9>"$root/.deploy.lock"
flock -n 9 || die 'Another deployment is active.'
previous=$(readlink -f "$root/current" 2>/dev/null || true)
if [[ -n $previous && $previous != "$root/current" ]]; then
  [[ $previous =~ ^/srv/zride/releases/[0-9a-f]{40}$ ]] || die 'Previous release is outside the release directory.'
else
  previous=
fi

if [[ ! -d $release ]]; then
  mkdir -m 700 "$release"
  # Reject links, special files, path traversal, duplicate entries and unrelated
  # files before extracting. File modes are normalized; nothing runs as root.
  python3 - "$archive" "$release" <<'PY'
from pathlib import Path, PurePosixPath
import os, shutil, sys, tarfile
archive, destination = sys.argv[1:]
destination = Path(destination)
if Path(archive).stat().st_size > 16 * 1024 * 1024:
    raise SystemExit('Runtime archive is too large')
with tarfile.open(archive, 'r:gz') as source:
    members = []
    for member in source:
        members.append(member)
        if len(members) > 500:
            raise SystemExit('Runtime archive has too many members')
    seen = set()
    expanded = 0
    for member in members:
        path = PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts:
            raise SystemExit('Unsafe archive path')
        name = path.as_posix()
        if name in seen:
            raise SystemExit('Duplicate archive path')
        seen.add(name)
        if not (member.isfile() or member.isdir()):
            raise SystemExit('Links and special files are prohibited')
        allowed = (len(path.parts) == 1 and (name in {'package.json', 'package-lock.json'} or name.endswith('.mjs'))) or (path.parts[0] in {'observer', 'phone-client'} and (member.isdir() or path.suffix in {'.html', '.css', '.js', '.json', '.svg'}))
        if not allowed:
            raise SystemExit('Unrelated file in runtime archive')
        expanded += member.size
        if expanded > 16 * 1024 * 1024:
            raise SystemExit('Expanded runtime archive exceeds 16 MiB')
    required = {'package.json', 'package-lock.json', 'server.mjs', 'world.mjs', 'state-store.mjs', 'observer.mjs', 'observer/index.html', 'observer/app.js', 'observer/style.css', 'phone-client.mjs', 'phone-client/index.html', 'phone-client/app.js', 'phone-client/style.css'}
    if not required.issubset(seen):
        raise SystemExit('Missing required runtime files')
    for member in members:
        target = destination.joinpath(*PurePosixPath(member.name).parts)
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
            target.chmod(0o755)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as incoming, target.open('xb') as output:
                shutil.copyfileobj(incoming, output)
            target.chmod(0o644)
    # File-only tar producers need not emit parent directory entries. mkdir's
    # implicit parents inherit the deployer's private umask, so normalize every
    # directory after extraction, not only explicit directory members.
    destination.chmod(0o755)
    for directory in destination.rglob('*'):
        if directory.is_dir():
            directory.chmod(0o755)
PY
  chown -R zride:zride "$release"
  chmod 755 "$release"
  runuser -u zride -- env HOME="$state" /bin/bash -c \
    'umask 022; cd "$1"; exec npm ci --omit=dev --ignore-scripts --no-audit --no-fund' _ "$release"
  chown -R root:root "$release"
  printf '%s\n' "$digest" > "$release/.archive-sha256"
  chmod 644 "$release/.archive-sha256"
else
  [[ -f $release/.archive-sha256 ]] || die 'Incomplete existing release; administrator inspection required.'
  [[ $(cat "$release/.archive-sha256") == "$digest" ]] || die 'This revision was already staged with a different archive.'
fi

switch_release() {
  local target=$1
  local staged="$root/.current-$revision-$$"
  ln -s "$target" "$staged"
  mv -Tf "$staged" "$root/current"
}
healthy() {
  local attempt
  for attempt in $(seq 1 30); do
    if curl --fail --silent --max-time 2 http://127.0.0.1:8000/healthz | \
      python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") is True and d.get("protocol")=="zride-demo-v1"' 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

stopped=false
recover_before_exit() {
  local status=$?
  if [[ $status -ne 0 && $stopped == true && -n $previous ]]; then
    switch_release "$previous"
    systemctl start "$service" || true
  fi
}
trap recover_before_exit EXIT

# An offline backup includes any WAL/SHM files. It is never restored
# automatically: rolling back already acknowledged game state would lose data.
systemctl stop "$service"
stopped=true
database_files=()
for name in zride.sqlite zride.sqlite-wal zride.sqlite-shm; do
  [[ ! -L $state/$name ]] || die 'Database backup path must not be a symlink.'
  if [[ -f $state/$name ]]; then database_files+=("$name"); fi
done
if [[ ${#database_files[@]} -gt 0 ]]; then
  install -d -m 700 /var/backups/zride
  backup="/var/backups/zride/database-$(date -u +%Y%m%dT%H%M%SZ)-$revision.tar.gz"
  tar -czf "$backup" -C "$state" -- "${database_files[@]}"
  chmod 600 "$backup"
fi
switch_release "$release"
if systemctl restart "$service" && healthy; then
  stopped=false
  printf 'Deployed Z-RIDE revision %s; health passed.\n' "$revision"
  exit 0
fi
printf 'New release failed health; preserving database and reverting code.\n' >&2
if [[ -n $previous ]]; then
  switch_release "$previous"
  systemctl restart "$service"
  healthy || die 'Rollback also failed health; inspect journalctl -u zride.service.'
  stopped=false
fi
exit 1
