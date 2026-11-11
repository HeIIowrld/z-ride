// Modified for Z-RIDE selected room capacity.
/*
 * Copyright 2026 Mohammad Mahdi Mortazavi
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* ============================= MATCHMAKER ===============================

   One global Durable Object holding one table. It answers three questions and
   nothing else:

     • is ABC123 a real room, and what mode is it?
     • where do I put someone who pressed QUICKPLAY on tdm?
     • which rooms have gone quiet and can be forgotten?

   It never touches a simulation and never holds a socket, so it stays cheap
   and stays awake for milliseconds at a time. Every row here is a hint about
   a MatchRoom, not the truth: the room itself is authoritative and pushes its
   state here as it changes. A stale row costs a player one wasted join, which
   is much cheaper than waking every room in the world to ask.                */

import { DurableObject } from 'cloudflare:workers';
import { MODES } from '../../shared/src/modes.js';

const PRUNE_AFTER = 30 * 60 * 1000;   // no activity for half an hour -> gone
const PRUNE_EVERY = 10 * 60 * 1000;

export class Matchmaker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // blockConcurrencyWhile so no RPC can observe a half-created schema.
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS rooms (
        code       TEXT PRIMARY KEY,
        mode       TEXT NOT NULL,
        is_public  INTEGER NOT NULL DEFAULT 0,
        host       TEXT,
        state      TEXT NOT NULL DEFAULT 'lobby',
        players    INTEGER NOT NULL DEFAULT 0,
        maxPlayers INTEGER NOT NULL,
        created    INTEGER NOT NULL,
        touched    INTEGER NOT NULL
      )`);
      // Quickplay's only query shape. Without this it is a table scan every
      // time somebody presses the big button.
      this.sql.exec(`CREATE INDEX IF NOT EXISTS rooms_open
        ON rooms (mode, is_public, state, players)`);
    });
  }

  /* ------------------------------------------------------------- CREATE */

  /** `candidates` is a list of codes the Worker already generated. Trying them
   *  in order here means collision handling costs zero extra round trips. */
  async createRoom(mode, isPublic, hostName, candidates) {
    const def = MODES[mode] || MODES.coop;
    const now = Date.now();
    for (const raw of candidates || []) {
      const code = String(raw || '').toUpperCase();
      if (code.length !== 6) continue;
      const taken = this.sql.exec('SELECT 1 FROM rooms WHERE code = ?', code).toArray();
      if (taken.length) continue;
      this.sql.exec(
        `INSERT INTO rooms (code, mode, is_public, host, state, players, maxPlayers, created, touched)
         VALUES (?, ?, ?, ?, 'lobby', 0, ?, ?, ?)`,
        code, def.id, isPublic ? 1 : 0, hostName || null, def.maxPlayers, now, now
      );
      await this.armPrune();
      return { code, mode: def.id, maxPlayers: def.maxPlayers, created: true };
    }
    return null;
  }

  /* --------------------------------------------------------------- READ */

  findRoom(code) {
    const rows = this.sql.exec('SELECT * FROM rooms WHERE code = ?', String(code || '').toUpperCase()).toArray();
    return rows.length ? shape(rows[0]) : null;
  }

  /** Joinable means exactly two things: still in the lobby, and not full. */
  listOpenRooms(mode, limit = 20) {
    const def = MODES[mode] || MODES.coop;
    const rows = this.sql.exec(
      `SELECT * FROM rooms
       WHERE mode = ? AND is_public = 1 AND state = 'lobby' AND players < maxPlayers
       ORDER BY players DESC, created ASC
       LIMIT ?`,
      def.id, Math.max(1, Math.min(50, limit))
    ).toArray();
    return rows.map(shape);
  }

  /* ---------------------------------------------------------- QUICKPLAY */

  async quickplay(mode, candidates, hostName) {
    // Fullest-first. Dropping a player into a lobby that already has three
    // people starts a match in seconds; spreading them evenly starts nothing.
    const open = this.listOpenRooms(mode, 1);
    if (open.length) {
      this.touch(open[0].code);
      return { code: open[0].code, mode: open[0].mode, created: false };
    }
    return await this.createRoom(mode, true, hostName, candidates);
  }

  /* -------------------------------------------------------- ROOM REPORTS */

  /** Called by MatchRoom whenever its headcount or lifecycle state moves.
   *  Rooms that were never registered (a direct DO id, a wiped table) get
   *  inserted so the directory self-heals instead of silently losing them. */
  async report(code, patch = {}) {
    const c = String(code || '').toUpperCase();
    if (c.length !== 6) return false;
    const now = Date.now();
    const existing = this.sql.exec('SELECT 1 FROM rooms WHERE code = ?', c).toArray();
    if (!existing.length) {
      const def = MODES[patch.mode] || MODES.coop;
      this.sql.exec(
        `INSERT INTO rooms (code, mode, is_public, host, state, players, maxPlayers, created, touched)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c, def.id, patch.isPublic ? 1 : 0, patch.host || null,
        patch.state || 'lobby', patch.players | 0, def.maxPlayers, now, now
      );
    } else {
      this.sql.exec(
        'UPDATE rooms SET state = COALESCE(?, state), players = COALESCE(?, players), maxPlayers = COALESCE(?, maxPlayers), touched = ? WHERE code = ?',
        patch.state ?? null, patch.players ?? null, patch.maxPlayers ?? null, now, c
      );
    }
    await this.armPrune();
    return true;
  }

  closeRoom(code) {
    this.sql.exec('DELETE FROM rooms WHERE code = ?', String(code || '').toUpperCase());
    return true;
  }

  touch(code) {
    this.sql.exec('UPDATE rooms SET touched = ? WHERE code = ?', Date.now(), String(code || '').toUpperCase());
  }

  stats() {
    const rows = this.sql.exec(
      `SELECT mode, state, COUNT(*) AS n, SUM(players) AS p FROM rooms GROUP BY mode, state`
    ).toArray();
    return rows.map(r => ({ mode: r.mode, state: r.state, rooms: Number(r.n), players: Number(r.p || 0) }));
  }

  /* -------------------------------------------------------------- PRUNE */

  async armPrune() {
    // One pending alarm at a time. Re-arming on every report would rewrite the
    // alarm row at 20Hz during a busy match for no benefit.
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + PRUNE_EVERY);
    }
  }

  async alarm() {
    this.sql.exec('DELETE FROM rooms WHERE touched < ?', Date.now() - PRUNE_AFTER);
    const left = this.sql.exec('SELECT COUNT(*) AS n FROM rooms').toArray();
    // Stop scheduling once the table is empty: an idle Matchmaker with no
    // alarm pending costs nothing at all.
    if (left.length && Number(left[0].n) > 0) {
      await this.ctx.storage.setAlarm(Date.now() + PRUNE_EVERY);
    }
  }
}

/** SQLite hands back BigInt for INTEGER columns in some paths; the wire wants
 *  plain numbers and booleans. */
function shape(r) {
  return {
    code: r.code,
    mode: r.mode,
    isPublic: !!Number(r.is_public),
    host: r.host || null,
    state: r.state,
    players: Number(r.players || 0),
    maxPlayers: Number(r.maxPlayers || 0),
    created: Number(r.created || 0),
    touched: Number(r.touched || 0)
  };
}
