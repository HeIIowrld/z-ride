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

/* =============================== MODES ==================================
   Three modes, one arena, one simulation. A mode is a small bundle of rules —
   who can hurt whom, what ends the match, what happens when you die — rather
   than a separate game. That is why adding one costs a dozen lines instead of
   a rewrite. */

import { T, TEAM_NAMES } from './constants.js';

export const MODES = {
  coop: {
    id: 'coop',
    name: 'DEADZONE',
    blurb: '주차장이 마지막 방어선이 된다.',
    pve: true, pvp: false,
    maxPlayers: 4, teams: 1,
    respawn: false,          // you go down, a teammate picks you up
    downState: true,
    reviveTime: T.modes.coop.reviveTime,
    reviveRadius: T.modes.coop.reviveRadius,
    waves: true,
    upgrades: true,
    scoreLimit: 0,
    timeLimit: 0,
    symmetricArena: false,
    /** Co-op scales by headcount, not linearly: four players are stronger than
     *  four times one player, so four times the enemies would be a slaughter. */
    creditScale(n) { return 1 + (n - 1) * T.director.coopCreditScale; },
    endCondition(sim) {
      return sim.players.every(p => !p.alive || p.down) ? { over: true, reason: 'wipe' } : null;
    }
  },

  tdm: {
    id: 'tdm',
    name: 'TEAM DEATHMATCH',
    blurb: 'Four against four. First to thirty.',
    pve: false, pvp: true,
    maxPlayers: T.modes.tdm.players, teams: 2, teamSize: T.modes.tdm.teamSize,
    respawn: true, respawnTime: T.player.respawn,
    downState: false,
    waves: false,
    upgrades: false,
    scoreLimit: T.modes.tdm.scoreLimit,
    timeLimit: T.modes.tdm.timeLimit,
    symmetricArena: true,
    hazards: true,           // a light PvE presence keeps the arena from going quiet
    creditScale() { return 0.30; },
    endCondition(sim) {
      for (let i = 0; i < sim.teamScore.length; i++) {
        if (sim.teamScore[i] >= this.scoreLimit) return { over: true, reason: 'score', winner: i };
      }
      if (this.timeLimit && sim.matchTime >= this.timeLimit) {
        let best = 0;
        for (let i = 1; i < sim.teamScore.length; i++) if (sim.teamScore[i] > sim.teamScore[best]) best = i;
        return { over: true, reason: 'time', winner: best };
      }
      return null;
    }
  },

  squad: {
    id: 'squad',
    name: 'SQUAD ROYALE',
    blurb: 'Four duos. One arena. It gets smaller.',
    pve: false, pvp: true,
    maxPlayers: T.modes.squad.players, teams: 4, teamSize: T.modes.squad.teamSize,
    respawn: true, respawnTime: T.player.respawn + 1.5,
    downState: true,          // a duo partner can pick you back up
    reviveTime: 2.6, reviveRadius: 3.0,
    waves: false,
    upgrades: false,
    scoreLimit: T.modes.squad.scoreLimit,
    timeLimit: T.modes.squad.timeLimit,
    symmetricArena: true,
    hazards: true,
    /** The arena closes in the last third. Nothing raises heart rate like the
     *  floor itself taking away your options. */
    shrink: { startFrac: T.modes.squad.shrinkAt, endRadiusFrac: 0.42, dps: 14 },
    creditScale() { return 0.22; },
    endCondition(sim) {
      for (let i = 0; i < sim.teamScore.length; i++) {
        if (sim.teamScore[i] >= this.scoreLimit) return { over: true, reason: 'score', winner: i };
      }
      const aliveTeams = new Set();
      for (const p of sim.players) if (p.alive && !p.down) aliveTeams.add(p.team);
      if (sim.matchTime > 20 && aliveTeams.size === 1 && sim.players.length > 2) {
        return { over: true, reason: 'lastsquad', winner: [...aliveTeams][0] };
      }
      if (this.timeLimit && sim.matchTime >= this.timeLimit) {
        let best = 0;
        for (let i = 1; i < sim.teamScore.length; i++) if (sim.teamScore[i] > sim.teamScore[best]) best = i;
        return { over: true, reason: 'time', winner: best };
      }
      return null;
    }
  }
};

export function getMode(id) { return MODES[id] || MODES.coop; }

export function teamName(i) { return TEAM_NAMES[i] || 'TEAM ' + (i + 1); }

/** Even spread, then fill. Used when a room starts and when a latecomer joins. */
export function balanceTeams(playerIds, mode) {
  const counts = new Array(mode.teams).fill(0);
  const out = new Map();
  for (const id of playerIds) {
    let best = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i] < counts[best]) best = i;
    counts[best]++;
    out.set(id, best);
  }
  return out;
}

/** Team spawn anchors, evenly spaced around the disc. */
export function teamSpawn(teamIndex, teamCount, radius, jitterRng) {
  const a = (teamIndex / Math.max(1, teamCount)) * Math.PI * 2;
  const r = radius * 0.74;
  const j = jitterRng ? jitterRng.range(0.22, -0.22) : 0;
  return { x: Math.cos(a + j) * r, z: Math.sin(a + j) * r, facing: a + Math.PI };
}
