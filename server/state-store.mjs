import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const STATE_FORMAT_VERSION = 2;

/** Single-instance durable checkpoint. One row means rewards and receipts commit together. */
export function createStateStore(filename) {
  const file = filename === ':memory:' ? filename : resolve(filename);
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  let revision = 0;
  let closed = false;
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    db.exec(`CREATE TABLE IF NOT EXISTS server_state (
      id INTEGER PRIMARY KEY CHECK (id=1),
      format_version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      payload TEXT NOT NULL,
      saved_at INTEGER NOT NULL
    ) STRICT`);
    const row = db.prepare('SELECT format_version, revision FROM server_state WHERE id=1').get();
    if (row && ![1, STATE_FORMAT_VERSION].includes(row.format_version)) throw new Error('Unsupported database state format; do not overwrite this database');
    revision = row?.revision ?? 0;
    if (file !== ':memory:') {
      for (const path of [file, file + '-wal', file + '-shm']) if (existsSync(path)) chmodSync(path, 0o600);
    }
  } catch (error) { db.close(); throw error; }
  return {
    kind: 'sqlite',
    load() {
      const row = db.prepare('SELECT payload FROM server_state WHERE id=1').get();
      return row ? JSON.parse(row.payload) : null;
    },
    save(state) {
      const payload = JSON.stringify(state);
      db.exec('BEGIN IMMEDIATE');
      try {
        if (revision === 0) {
          db.prepare('INSERT INTO server_state(id,format_version,revision,payload,saved_at) VALUES(1,?,?,?,?)')
            .run(STATE_FORMAT_VERSION, 1, payload, Date.now());
        } else {
          const updated = db.prepare('UPDATE server_state SET payload=?,format_version=?,revision=revision+1,saved_at=? WHERE id=1 AND revision=?')
            .run(payload, STATE_FORMAT_VERSION, Date.now(), revision);
          if (updated.changes !== 1) throw new Error('Database revision conflict: run one server per database');
        }
        db.exec('COMMIT');
        revision++;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
