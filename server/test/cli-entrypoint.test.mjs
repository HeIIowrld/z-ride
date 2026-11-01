import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, stat, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('CLI starts persistent server through a release directory symlink or Windows junction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zride-cli-entrypoint-'));
  const serverDirectory = fileURLToPath(new URL('../', import.meta.url));
  const current = join(directory, 'current');
  const dbPath = join(directory, 'state.sqlite');
  let child;
  try {
    await symlink(serverDirectory, current, process.platform === 'win32' ? 'junction' : 'dir');
    child = spawn(process.execPath, [join(current, 'server.mjs')], {
      cwd: directory,
      env: { ...process.env, HOST: '127.0.0.1', PORT: '0', ZRIDE_DB_PATH: dbPath, ZRIDE_OBSERVER_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.resume();
    let output = '';
    const ready = await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error('Symlink CLI did not become ready')), 7000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error('Symlink CLI exited before server.ready: ' + code)); });
      child.stdout.on('data', bytes => {
        output += bytes.toString('utf8');
        for (const line of output.split(/\r?\n/)) {
          let message; try { message = JSON.parse(line); } catch { continue; }
          if (message.event === 'server.ready') { clearTimeout(timeout); resolveReady(message); }
        }
      });
    });
    assert.equal(ready.persistence, 'sqlite');
    assert.ok(ready.address.port > 0);
    const response = await fetch(`http://127.0.0.1:${ready.address.port}/healthz`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
    assert.ok((await stat(dbPath)).size > 0);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolveExit => child.once('exit', resolveExit));
      child.kill('SIGKILL'); await exited;
    }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('zride-cli-entrypoint-'));
    await rm(directory, { recursive: true, force: true });
  }
});
