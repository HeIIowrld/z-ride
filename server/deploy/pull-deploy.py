#!/usr/bin/env python3
"""Root-installed deploy poller: only successful same-repository main pushes.

Runs as zride-runner. It never executes downloaded checkout code or reads a GitHub
credential. The only privileged action is the existing fixed sudo deploy command.
"""
from pathlib import Path, PurePosixPath
import gzip
import hashlib
import io
import json
import os
import re
import subprocess
import tarfile
import urllib.request

REPOSITORY = 'HeIIowrld/z-ride'
ROOT = Path('/srv/zride')
MAX_DOWNLOAD = 16 * 1024 * 1024
REQUIRED = {
    'package.json', 'package-lock.json', 'server.mjs', 'world.mjs',
    'state-store.mjs', 'effects.mjs', 'observer.mjs', 'observer/index.html',
    'observer/app.js', 'observer/style.css', 'phone-client.mjs',
    'phone-client/index.html', 'phone-client/app.js', 'phone-client/style.css',
}


def fetch(url):
    request = urllib.request.Request(url, headers={
        'User-Agent': 'zride-trusted-main-puller',
        'Accept': 'application/vnd.github+json' if 'api.github.com/' in url else 'application/gzip',
        'X-GitHub-Api-Version': '2026-03-10',
    })
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = response.read(MAX_DOWNLOAD + 1)
    if len(payload) > MAX_DOWNLOAD:
        raise ValueError('Download exceeds limit')
    return payload


def tested_revision(document):
    """Never accept PR runs, forks, unsuccessful runs or an unbounded SHA."""
    for run in document.get('workflow_runs', []):
        if (run.get('event') == 'push' and run.get('head_branch') == 'main'
                and run.get('status') == 'completed' and run.get('conclusion') == 'success'
                and run.get('head_repository', {}).get('full_name') == REPOSITORY
                and run.get('path') == '.github/workflows/server-ci.yml'
                and re.fullmatch('[0-9a-f]{40}', run.get('head_sha', ''))):
            return run['head_sha']
    raise ValueError('No trusted successful main CI revision found')


def runtime_bundle(payload):
    """Repackage an immutable public source archive without copying data/tools."""
    files = {}
    expanded = 0
    prefix = None
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as source:
        for index, member in enumerate(source):
            if index >= 5000:
                raise ValueError('Source archive has too many entries')
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts:
                raise ValueError('Unsafe source path')
            if prefix is None:
                prefix = path.parts[0]
            if path.parts[0] != prefix or not (member.isdir() or member.isfile()):
                raise ValueError('Unexpected source entry')
            expanded += member.size
            if expanded > 32 * 1024 * 1024:
                raise ValueError('Expanded source exceeds limit')
            if len(path.parts) < 3 or path.parts[1] != 'server' or not member.isfile():
                continue
            relative = PurePosixPath(*path.parts[2:])
            name = relative.as_posix()
            allowed = (
                len(relative.parts) == 1 and
                (name in {'package.json', 'package-lock.json'} or name.endswith('.mjs'))
            ) or (
                relative.parts[0] in {'observer', 'phone-client'} and
                relative.suffix in {'.html', '.css', '.js', '.json', '.svg'}
            )
            if not allowed:
                continue
            if name in files:
                raise ValueError('Duplicate runtime file')
            files[name] = source.extractfile(member).read()
    if not REQUIRED.issubset(files):
        raise ValueError('Source revision lacks the required runtime files')
    output = io.BytesIO()
    with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
            for name, data in sorted(files.items()):
                member = tarfile.TarInfo(name)
                member.mode, member.size = 0o644, len(data)
                archive.addfile(member, io.BytesIO(data))
    return output.getvalue()


def main():
    runs = json.loads(fetch(
        f'https://api.github.com/repos/{REPOSITORY}/actions/workflows/server-ci.yml/runs'
        '?branch=main&event=push&status=success&per_page=5'
    ))
    revision = tested_revision(runs)
    if (ROOT / 'current').resolve().name == revision:
        print(f'Already running tested main {revision}')
        return
    bundle = runtime_bundle(fetch(f'https://codeload.github.com/{REPOSITORY}/tar.gz/{revision}'))
    digest = hashlib.sha256(bundle).hexdigest()
    archive = ROOT / 'incoming' / f'zride-server-{revision}.tar.gz'
    temporary = archive.with_suffix('.pending')
    # Refuse a pre-existing symlink even though the incoming directory belongs
    # to this unprivileged user. The root entrypoint validates again.
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as target:
            target.write(bundle)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, archive)
        subprocess.run(['sudo', '-n', '/usr/local/sbin/zride-deploy', revision, digest],
                       check=True, timeout=180)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
