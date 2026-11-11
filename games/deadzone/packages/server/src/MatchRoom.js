// Modified for Z-RIDE: fixed party sizes and read-only vehicle dashboard.
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

/* ============================== MATCH ROOM ==============================

   The authority. One Durable Object per match, holding one Sim, ticking at
   T.sim.netHz. Nothing a client sends is believed: inputs are intents, and the
   only thing that decides where a player is, whether a shot landed, how much
   it hurt, or whether a dash was legal, is `sim.step`.

   Two constraints shape everything below.

   1. HIBERNATION. `ctx.acceptWebSocket` hands the sockets to the runtime, so a
      room can be evicted from memory while eight people sit in its lobby
      arguing about the mode, and cost nothing while they do. The moment any of
      them speaks, the DO wakes and the socket is still there. Consequence: no
      important per-socket state lives in a closure — it lives in the socket's
      attachment, which survives eviction.

   2. THE FREE PLAN BILLS DURATION. A `setInterval` is the one thing here that
      pins the object in memory, so the interval runs only while a match is
      actually moving. A lobby is entirely event-driven; an empty room is
      entirely asleep.

   A hibernation during 'playing' would take the in-memory Sim with it, and no
   amount of storage would bring that match back honestly. It cannot happen —
   the tick timer prevents eviction — but if it ever did, the room detects the
   missing Sim on wake and drops everyone back to the lobby instead of
   improvising a state nobody agreed to.                                      */

import { DurableObject } from 'cloudflare:workers';
import { partySize, dashboardSnapshot } from '../../shared/src/zride.js';

import { Sim } from '../../shared/src/sim.js';
import { ABILITIES } from '../../shared/src/abilities.js';
import { offerUpgrades } from '../../shared/src/upgrades.js';
import { MODES } from '../../shared/src/modes.js';
import { T } from '../../shared/src/constants.js';
import { hashString } from '../../shared/src/rng.js';
import {
  MSG, Reader, decodeInput, decodeJson,
  encodeSnapshot, encodeEvents, encodeJson
} from '../../shared/src/protocol.js';

import { driveBots } from './bots.js';

const DT = 1 / T.sim.netHz;
const TICK_MS = 1000 / T.sim.netHz;

const COUNTDOWN_SECONDS = 5;
const SCOREBOARD_SECONDS = 15;
const CHOICE_SECONDS = 12;
const GRACE_MS = T.net.reconnectGrace * 1000;
const IDLE_CLOSE_MS = 5 * 60 * 1000;

/** Co-op will start for one person; PvP needs somebody to shoot at. */
const MIN_PLAYERS = { coop: 1, tdm: 2, squad: 2 };

/* An honest client sends T.sim.inputHz (30) input frames a second. 45 leaves
   room for a burst after a stalled tab without ever letting a script drive the
   simulation faster than everyone else. Excess is dropped, not punished: a
   flaky mobile connection that bunches packets is not an attacker, and
   disconnecting it would be exactly the wrong response. */
const INPUT_BUDGET = 45;
const CHAT_MAX = 120;
const CHAT_COOLDOWN_MS = 2000;

/* Projectiles are the most volatile third of a snapshot and the only part a
   client can extrapolate exactly — they travel in straight lines at a velocity
   we already sent. Enemies cannot be extrapolated the same way because they
   change heading constantly, so they go every tick, always. Halving projectile
   rate only kicks in during the bullet storms where bandwidth actually bites. */
const PROJECTILE_STORM = 60;

export class MatchRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;

    this.sim = null;
    this.timer = null;

    /** ws -> volatile scratch (rate-limit counters, chat clock). Rebuilt on
     *  demand; nothing in here is worth surviving an eviction. */
    this.scratch = new Map();
    /** token -> {playerId, name, skin, team, until} for players inside the
     *  reconnect grace window. */
    this.ghosts = new Map();
    this.bots = new Set();

    this.countdownT = 0;
    this.endT = 0;
    this.choiceT = 0;
    this.choiceWave = -1;
    this.choices = new Map();     // playerId -> {cards, picked}
    this.lastCountdownSent = -1;

    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get('room')) || null;
    });
  }

  /* ------------------------------------------------------------- JOINING */

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/internal/zride/configure' && request.method === 'POST') {
      const body = await request.json();
      this.ensureRoom(body.code, 'coop');
      if (this.room.dashboardToken) return Response.json({error:'already_configured'}, {status:409});
      this.room.targetPlayers = partySize(body.players);
      this.room.dashboardToken = body.dashboardToken;
      await this.ctx.storage.put('room', this.room);
      await this.report();
      return Response.json({ok:true});
    }
    if (path === '/internal/zride/status') {
      if (!this.room?.dashboardToken || request.headers.get('x-dashboard-token') !== this.room.dashboardToken)
        return Response.json({error:'forbidden'}, {status:403});
      this.recoverIfOrphaned();
      return Response.json(dashboardSnapshot(this.room, this.sim, this.roster()),
        {headers:{'cache-control':'no-store'}});
    }
    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
    if (upgrade !== 'websocket') return new Response('expected websocket upgrade', { status: 426 });

    const url = new URL(request.url);
    const code = request.headers.get('x-overrun-code') || '';
    const mode = request.headers.get('x-overrun-mode') || 'coop';

    this.ensureRoom(code, mode);
    // The results POST goes back through the same Worker that proxied this
    // upgrade, so the origin is learned here rather than configured. Persisted
    // because a room that hibernates in the lobby still has to know where to
    // send the scoreboard for the match it plays after waking up.
    if (this.room.origin !== url.origin) { this.room.origin = url.origin; this.save(); }
    this.recoverIfOrphaned();

    const def = MODES[this.room.mode] || MODES.coop;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Hibernatable: the runtime, not this object, holds the socket.
    this.ctx.acceptWebSocket(server);

    const token = String(url.searchParams.get('pid') || '').slice(0, 48) || crypto.randomUUID();
    server.serializeAttachment({
      token,
      playerId: null,
      name: null,
      skin: 0,
      authId: null,
      ready: false,
      joined: Date.now()
    });

    // Refuse politely over the socket rather than with an HTTP status: a
    // browser cannot read the body of a failed upgrade, so a 409 tells the
    // player nothing at all.
    if (this.ctx.getWebSockets().length + this.ghosts.size > this.capacity() && !this.ghosts.has(token)) {
      this.send(server, encodeJson(MSG.KICK, { reason: 'full', code: this.room.code }));
      try { server.close(4003, 'room full'); } catch { /* already gone */ }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  ensureRoom(code, mode) {
    if (this.room && this.room.code) return;
    const def = MODES[mode] || MODES.coop;
    this.room = {
      code: code || 'UNKNWN',
      mode: def.id,
      state: 'lobby',
      // Room code is the world seed. A reconnecting client that only knows the
      // code can rebuild the identical arena without a byte of geometry.
      seed: hashString(code || 'UNKNWN') >>> 0,
      rematch: 0,
      nextPid: 1,
      created: Date.now()
    };
    this.save();
  }

  /** Woke up believing a match was running, but the Sim died with the memory
   *  it lived in. Only reachable if the runtime evicts an object with an active
   *  timer, which it should not — treated as a hard reset, never as a fudge. */
  recoverIfOrphaned() {
    if (!this.room) return;
    // 'playing' without a Sim is unrecoverable. 'countdown' and 'ended' without
    // a running clock are merely stuck — both mean nobody is coming back to
    // finish what this room started, so it goes back to being a lobby.
    const stalled = this.room.state === 'playing'
      ? !this.sim
      : (this.room.state !== 'lobby' && this.timer === null);
    if (stalled) {
      this.room.state = 'lobby';
      this.save();
      this.broadcast(encodeJson(MSG.LOBBY, this.lobbyPayload('recovered')));
    }
  }

  /* ------------------------------------------------------------ MESSAGES */

  webSocketMessage(ws, message) {
    // Every handler below is wrapped: a single malformed packet from one phone
    // must not be able to take a match away from seven other people.
    try {
      if (typeof message === 'string') return;   // the protocol is binary-only
      // First thing after a wake: a socket that outlived its match must not be
      // able to keep talking to a state that no longer exists.
      this.recoverIfOrphaned();
      const r = new Reader(message);
      if (r.left < 1) return;
      const type = r.u8();

      switch (type) {
        case MSG.HELLO: return this.onHello(ws, decodeJson(r) || {});
        case MSG.INPUT: return this.onInput(ws, r);
        case MSG.VEHICLE_ACTION: return this.onVehicleAction(ws, decodeJson(r));
        case MSG.PING: return this.onPing(ws, decodeJson(r) || {});
        case MSG.CHAT: return this.onChat(ws, decodeJson(r) || {});
        case MSG.PICK: return this.onPick(ws, decodeJson(r) || {});
        case MSG.READY: return this.onReady(ws, decodeJson(r) || {});
        default: return;   // unknown type: silently ignored, never fatal
      }
    } catch (err) {
      console.log('room message error', String((err && err.stack) || err));
    }
  }

  onHello(ws, body) {
    const att = ws.deserializeAttachment() || {};
    if (att.playerId) return;   // HELLO is once per socket

    const def = MODES[this.room.mode] || MODES.coop;
    const name = cleanName(body.name);
    const skin = clampInt(body.skin, 0, 15);
    const authId = typeof body.authId === 'string' ? body.authId.slice(0, 64) : null;

    // Reconnect: a phone that hopped from wifi to LTE keeps its character, its
    // score and its upgrades, as long as it is back inside the grace window.
    let playerId = null;
    const ghost = this.ghosts.get(att.token) || (authId ? this.ghostByAuth(authId) : null);
    if (ghost && ghost.until > Date.now()) {
      playerId = ghost.playerId;
      this.ghosts.delete(ghost.token);
      const p = this.sim && this.sim.playerById(playerId);
      if (p) { p.connected = true; p.name = name; }
    }

    if (playerId === null) {
      if (this.room.mode === 'coop' && this.room.state !== 'lobby') {
        this.send(ws, encodeJson(MSG.KICK, {reason:'match_in_progress'}));
        ws.close(4003, 'match in progress'); return;
      }
      if (this.humanCount() >= this.capacity()) {
        this.send(ws, encodeJson(MSG.KICK, { reason: 'full' }));
        try { ws.close(4003, 'room full'); } catch { /* already gone */ }
        return;
      }
      playerId = this.nextPlayerId();
      // Joining mid-match is allowed in PvP (respawns exist) but not in co-op,
      // where a wave has already been composed against a fixed headcount.
      if (this.room.state === 'playing' && this.sim && def.pvp) {
        this.sim.addPlayer(playerId, { name, skin, bot: false });
        this.sim.rebalanceTeams();
      }
    }

    ws.serializeAttachment({ ...att, playerId, name, skin, authId, ready: false });

    this.send(ws, encodeJson(MSG.WELCOME, {
      playerId,
      code: this.room.code,
      seed: this.room.seed,
      mode: this.room.mode,
      tickRate: T.sim.netHz,
      inputRate: T.sim.inputHz,
      worldProps: this.ensureSim().world.snapshot(),
      you: { id: playerId, name, skin, token: att.token },
      players: this.roster(),
      state: this.room.state,
      minPlayers: MIN_PLAYERS[this.room.mode] ?? 1,
      maxPlayers: this.capacity(),
      targetPlayers: this.room.targetPlayers || null
    }));

    this.broadcastLobby('join');
    this.report();
    this.armAlarm().catch(() => { /* alarm is a safety net, not a dependency */ });
    // A room whose last player dropped mid-match parked its clock. Somebody is
    // here now, so it starts again exactly where it stopped.
    if (this.room.state !== 'lobby') this.startTimer();
  }

  onInput(ws, reader) {
    const att = ws.deserializeAttachment();
    if (!att || !att.playerId) return;
    if (!this.sim || this.room.state !== 'playing') return;
    if (!this.allowInput(ws)) return;
    // A truncated input frame is a dropped packet, not an attack. Checking the
    // length here keeps it out of the exception path entirely.
    if (reader.left < 7) return;

    const input = decodeInput(reader);
    // Straight into the Sim. Every field is an intent; the simulation clamps
    // movement, decides the fire rate, and owns the dash charges.
    this.sim.setInput(att.playerId, input);
  }

  onVehicleAction(ws, body) {
    if (this.room.state !== 'playing' || !this.sim?.defense || this.sim.over ||
      this.sim.director.phase === 'choice' || !this.allowInput(ws)) return;
    const p = this.sim.playerById(ws.deserializeAttachment()?.playerId);
    this.sim.defense.use(p, body?.action);
  }

  onPing(ws, body) {
    // JSON rather than a packed frame: two of these per player every second is
    // rounding error on the wire, and a readable clock message is worth more
    // during a lag investigation than the twelve bytes it saves.
    this.send(ws, encodeJson(MSG.PONG, { t: body.t ?? 0, s: Date.now(), tick: this.sim ? this.sim.tick : 0 }));
  }

  onChat(ws, body) {
    const att = ws.deserializeAttachment();
    if (!att || !att.playerId) return;
    const sc = this.scratchFor(ws);
    const now = Date.now();
    if (now - sc.lastChat < CHAT_COOLDOWN_MS) return;
    const text = String(body.text || '').slice(0, CHAT_MAX).trim();
    if (!text) return;
    sc.lastChat = now;
    this.broadcast(encodeJson(MSG.CHATOUT, { id: att.playerId, name: att.name, text, at: now }));
  }

  onReady(ws, body) {
    const att = ws.deserializeAttachment();
    if (!att || !att.playerId) return;
    if (this.room.state !== 'lobby') return;
    const ready = body && body.ready !== undefined ? !!body.ready : !att.ready;
    ws.serializeAttachment({ ...att, ready });
    this.broadcastLobby();
    this.maybeStartCountdown();
  }

  onPick(ws, body) {
    const att = ws.deserializeAttachment();
    if (!att || !att.playerId) return;
    if (!this.sim || this.sim.director.phase !== 'choice') return;

    const entry = this.choices.get(att.playerId);
    if (!entry || entry.picked) return;

    // The offer is server-generated and server-remembered. A client that asks
    // for a card it was not shown gets nothing, so PICK cannot become a
    // "give me every upgrade" endpoint.
    const card = entry.cards.find(c => c.id === body.id && c.kind === (body.kind || c.kind));
    if (!card) return;

    entry.picked = true;
    this.applyCard(att.playerId, card);
    this.maybeFinishChoice();
  }

  /* ---------------------------------------------------------- LIFECYCLE */

  maybeStartCountdown() {
    if (this.room.state !== 'lobby') return;
    const roster = this.roster().filter(p => !p.bot);
    const min = this.room.targetPlayers || MIN_PLAYERS[this.room.mode] || 1;
    if (roster.length < min) return;
    if (!roster.every(p => p.ready)) return;

    this.room.state = 'countdown';
    this.countdownT = COUNTDOWN_SECONDS;
    this.lastCountdownSent = -1;
    this.save();
    this.report();
    this.startTimer();
    this.broadcastLobby();
  }

  startMatch() {
    const def = MODES[this.room.mode] || MODES.coop;

    // Fresh Sim per match so a rematch cannot inherit last match's upgrades,
    // corpses or half-finished wave. The seed moves with the rematch counter,
    // which is why the arena is different the second time around.
    this.sim = this.createSim();
    this.bots.clear();
    this.choices.clear();
    this.choiceWave = -1;

    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (!att || !att.playerId) continue;
      this.sim.addPlayer(att.playerId, { name: att.name, skin: att.skin, bot: false });
    }
    if (def.pvp) {
      this.sim.rebalanceTeams();
      this.backfillBots(def);
      this.sim.rebalanceTeams();
    }
    if (this.sim.mode.waves) this.sim.director.startWave();

    this.room.state = 'playing';
    this.save();
    this.report();

    this.broadcast(encodeJson(MSG.LOBBY, {
      ...this.lobbyPayload('start'),
      // Resent at kickoff: the geometry a client received while sitting in the
      // lobby belongs to the previous seed if this is a rematch.
      worldProps: this.sim.world.snapshot(),
      seed: this.sim.seed
    }));
    this.startTimer();
  }

  /** Even teams or it is not a match. Bots fill the short team up to the size
   *  of the longest one, and a lone human always gets one opponent. */
  backfillBots(def) {
    const counts = new Array(def.teams).fill(0);
    for (const p of this.sim.players) counts[p.team] = (counts[p.team] || 0) + 1;

    let target = Math.max(1, ...counts);
    if (this.sim.players.length < 2) target = 1;

    for (let team = 0; team < def.teams; team++) {
      while (counts[team] < target && this.sim.players.length < this.capacity()) {
        const id = this.nextPlayerId();
        this.sim.addPlayer(id, { name: botName(id), team, bot: true });
        this.bots.add(id);
        counts[team]++;
      }
    }
    // One human, one bot: a 1v0 is a menu screen with extra steps.
    if (this.sim.players.length === 1 && this.capacity() > 1) {
      const id = this.nextPlayerId();
      this.sim.addPlayer(id, { name: botName(id), team: 1 % def.teams, bot: true });
      this.bots.add(id);
    }
  }

  endMatch() {
    if (this.room.state === 'ended') return;
    const results = this.results();

    this.room.state = 'ended';
    this.endT = SCOREBOARD_SECONDS;
    this.save();
    this.report();

    this.broadcast(encodeJson(MSG.END, {
      over: this.sim ? this.sim.over : null,
      teamScore: this.sim ? this.sim.teamScore.slice() : [],
      wave: this.sim ? this.sim.director.wave : 0,
      results,
      rematchIn: SCOREBOARD_SECONDS
    }));

    // Fire and forget, deliberately. The scoreboard is already on eight
    // screens; Supabase being slow must never delay the next tick.
    this.postResults(results);
  }

  resetToLobby(reason = 'rematch') {
    this.stopTimer();
    this.sim = null;
    this.bots.clear();
    this.choices.clear();
    this.choiceWave = -1;
    this.room.state = 'lobby';
    this.room.rematch = (this.room.rematch || 0) + 1;
    this.save();

    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att) ws.serializeAttachment({ ...att, ready: false });
    }
    this.report();
    this.broadcast(encodeJson(MSG.LOBBY, this.lobbyPayload(reason)));
  }

  /* --------------------------------------------------------------- TICK */

  startTimer() {
    if (this.timer !== null) return;
    // The interval is what keeps this object resident. It exists only while
    // there is something to simulate.
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stopTimer() {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    try {
      if (this.ctx.getWebSockets().length === 0) {
        // Nobody left to simulate for. Stop billing. The clock restarts if
        // someone reconnects inside the grace window; the alarm tears the room
        // down if nobody does.
        this.stopTimer();
        return;
      }

      if (this.room.state === 'countdown') return this.tickCountdown();
      if (this.room.state === 'ended') return this.tickEnded();
      if (this.room.state !== 'playing' || !this.sim) { this.stopTimer(); return; }

      const sim = this.sim;
      driveBots(sim, DT);
      if (sim.defense) sim.world.animate(DT);
      sim.step(DT);
      this.stepChoice();

      const snap = sim.snapshot();
      const skipProjectiles = snap.projectiles.length > PROJECTILE_STORM && (sim.tick & 1) === 1;
      const frame = encodeSnapshot(snap, { skipProjectiles });
      this.broadcast(frame);

      const events = [];
      // Drained every tick regardless of listeners: the queue is capped and
      // would otherwise start dropping the oldest events on the floor.
      sim.events.drain(e => events.push(e));
      if (events.length) this.broadcast(encodeEvents(events));

      if (sim.over) this.endMatch();
    } catch (err) {
      console.log('room tick error', String((err && err.stack) || err));
      // A thrown tick is unrecoverable for this match but not for this room.
      this.resetToLobby('error');
    }
  }

  tickCountdown() {
    this.countdownT -= DT;
    const whole = Math.ceil(this.countdownT);
    if (whole !== this.lastCountdownSent) {
      this.lastCountdownSent = whole;
      this.broadcast(encodeJson(MSG.LOBBY, this.lobbyPayload('countdown')));
    }
    if (this.countdownT <= 0) this.startMatch();
  }

  tickEnded() {
    this.endT -= DT;
    if (this.endT <= 0) this.resetToLobby('rematch');
  }

  /* ------------------------------------------------------- CO-OP CHOICE */

  stepChoice() {
    const sim = this.sim;
    if (!sim.mode.upgrades) return;

    if (sim.director.phase !== 'choice') {
      if (this.choices.size) this.choices.clear();
      return;
    }

    if (this.choiceWave !== sim.director.wave) {
      this.choiceWave = sim.director.wave;
      this.choiceT = CHOICE_SECONDS;
      this.choices.clear();

      for (const p of sim.players) {
        // sim.rng on purpose — the shared offer function is written to be
        // driven by the simulation's generator so a client that predicts the
        // same wave is offered the same three cards.
        const cards = offerUpgrades(sim.rng, p, ABILITIES, 3);
        this.choices.set(p.id, { cards, picked: false });
        if (p.bot) { this.applyCard(p.id, cards[0]); this.choices.get(p.id).picked = true; continue; }
        const ws = this.socketFor(p.id);
        if (ws) this.send(ws, encodeJson(MSG.CHOICE, { wave: sim.director.wave, seconds: CHOICE_SECONDS, cards }));
      }
      this.maybeFinishChoice();
      return;
    }

    this.choiceT -= DT;
    if (this.choiceT > 0) return;

    // Twelve seconds is long enough to read three cards and short enough that
    // one person walking away cannot hold three others hostage.
    for (const [id, entry] of this.choices) {
      if (entry.picked) continue;
      entry.picked = true;
      this.applyCard(id, entry.cards[0]);
    }
    this.finishChoice();
  }

  maybeFinishChoice() {
    for (const entry of this.choices.values()) if (!entry.picked) return;
    this.finishChoice();
  }

  finishChoice() {
    if (!this.sim || this.sim.director.phase !== 'choice') return;
    this.choices.clear();
    this.sim.director.startWave();
  }

  applyCard(playerId, card) {
    const p = this.sim && this.sim.playerById(playerId);
    if (!p || !card) return;
    if (card.kind === 'ability') this.sim.grantAbility(p, card.id, card.slot);
    else this.sim.applyUpgrade(p, card.id);
  }

  /* --------------------------------------------------- DISCONNECT / ALARM */

  webSocketClose(ws) { this.onGone(ws); }
  webSocketError(ws) { this.onGone(ws); }

  onGone(ws) {
    try {
      this.scratch.delete(ws);
      const att = ws.deserializeAttachment();
      if (!att || !att.playerId) { this.afterDeparture(); return; }

      const p = this.sim && this.sim.playerById(att.playerId);
      if (p && this.room.state !== 'lobby') {
        // Held, not removed. Their body stays in the arena (and stays
        // shootable) so a 20-second tunnel does not cost them the match.
        p.connected = false;
        this.ghosts.set(att.token, {
          token: att.token, playerId: att.playerId, name: att.name,
          skin: att.skin, authId: att.authId, until: Date.now() + GRACE_MS
        });
        this.armAlarm().catch(() => { /* alarm is a safety net, not a dependency */ });
      } else if (p) {
        this.sim.removePlayer(att.playerId);
      }
      this.afterDeparture();
    } catch (err) {
      console.log('room close error', String((err && err.stack) || err));
    }
  }

  afterDeparture() {
    if (this.room?.state === 'countdown' && (this.roster().filter(p=>p.connected).length < (this.room.targetPlayers || MIN_PLAYERS[this.room.mode] || 1) || !this.roster().every(p=>p.connected && p.ready))) {
      this.room.state = 'lobby'; this.countdownT = 0; this.stopTimer(); this.save();
    }
    this.report();
    this.broadcastLobby();
    if (this.ctx.getWebSockets().length === 0) {
      this.stopTimer();
      this.armAlarm().catch(() => { /* alarm is a safety net, not a dependency */ });
    }
  }

  async armAlarm() {
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + Math.min(GRACE_MS, IDLE_CLOSE_MS));
  }

  async alarm() {
    if (!this.room) return;   // storage already wiped by a previous alarm
    const now = Date.now();
    for (const [token, g] of this.ghosts) {
      if (g.until > now) continue;
      this.ghosts.delete(token);
      if (this.sim) this.sim.removePlayer(g.playerId);
    }

    const sockets = this.ctx.getWebSockets().length;
    if (sockets === 0 && this.ghosts.size === 0) {
      // Nothing and nobody. Drop the row from the directory and let the object
      // go back to being a name in a hash table.
      this.stopTimer();
      this.sim = null;
      try { await this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName('global')).closeRoom(this.room.code); }
      catch { /* directory is a cache; a stale row prunes itself in 30 minutes */ }
      await this.ctx.storage.deleteAll();
      return;
    }

    this.report();
    if (this.ghosts.size) await this.ctx.storage.setAlarm(now + 5000);
    else if (sockets === 0) await this.ctx.storage.setAlarm(now + IDLE_CLOSE_MS);
  }

  /* -------------------------------------------------------------- OUTPUT */

  send(ws, bytes) {
    try { ws.send(toBuffer(bytes)); } catch { /* socket died between frames */ }
  }

  broadcast(bytes) {
    // One copy, eight sends. `Writer.bytes()` is a view into a larger buffer,
    // so it has to be sliced before it goes on the wire.
    const buf = toBuffer(bytes);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(buf); } catch { /* socket died between frames */ }
    }
  }

  broadcastLobby(reason = null) {
    // Sent on join, leave and ready only — never per tick. A snapshot carries
    // ids, but names, skins and the bot flag only travel in the roster.
    this.broadcast(encodeJson(MSG.LOBBY, this.lobbyPayload(reason)));
  }

  lobbyPayload(reason = null) {
    const def = MODES[this.room.mode] || MODES.coop;
    return {
      reason,
      code: this.room.code,
      mode: this.room.mode,
      state: this.room.state,
      seed: this.matchSeed(),
      tickRate: T.sim.netHz,
      countdown: this.room.state === 'countdown' ? Math.max(0, Math.ceil(this.countdownT)) : 0,
      minPlayers: MIN_PLAYERS[this.room.mode] ?? 1,
      maxPlayers: this.capacity(),
      targetPlayers: this.room.targetPlayers || null,
      players: this.roster()
    };
  }

  /** The binary snapshot has no spare field for "this one is a robot", so the
   *  bot flag rides in this roster instead. It is broadcast on every join,
   *  leave and state change, and at match start after backfill — which is the
   *  only moment bots can appear. */
  roster() {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (!att || !att.playerId) continue;
      const p = this.sim && this.sim.playerById(att.playerId);
      out.push({
        id: att.playerId, name: att.name, skin: att.skin,
        ready: !!att.ready, bot: false, connected: true,
        team: p ? p.team : 0
      });
    }
    for (const g of this.ghosts.values()) {
      out.push({ id: g.playerId, name: g.name, skin: g.skin, ready: false, bot: false, connected: false, team: 0 });
    }
    for (const id of this.bots) {
      const p = this.sim && this.sim.playerById(id);
      if (!p) continue;
      out.push({ id, name: p.name, skin: 0, ready: true, bot: true, connected: true, team: p.team });
    }
    return out;
  }

  /** Which Supabase profile each player id belongs to. Read off the live
   *  sockets and the grace list rather than stored on the Sim player, because
   *  identity is a connection concern and the simulation has no business
   *  knowing it. */
  authIds() {
    const map = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att && att.playerId && att.authId) map.set(att.playerId, att.authId);
    }
    for (const g of this.ghosts.values()) if (g.authId) map.set(g.playerId, g.authId);
    return map;
  }

  results() {
    if (!this.sim) return [];
    const winner = this.sim.over && this.sim.over.winner;
    const auth = this.authIds();
    return this.sim.players.map(p => ({
      playerId: p.id,
      name: p.name,
      authId: p.bot ? null : (auth.get(p.id) || null),
      bot: !!p.bot,
      team: p.team,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      score: Math.round(p.score),
      damageDealt: Math.round(p.damageDealt),
      damageTaken: Math.round(p.damageTaken),
      shotsFired: p.shotsFired,
      shotsHit: p.shotsHit,
      accuracy: p.shotsFired > 0 ? +(p.shotsHit / p.shotsFired).toFixed(3) : 0,
      won: winner === null || winner === undefined ? null : p.team === winner
    }));
  }

  async postResults(results) {
    const origin = this.room && this.room.origin;
    if (!origin || !this.env.INTERNAL_SECRET) return;
    if (!results.length) return;

    // Shaped for the `submit-match` Edge Function, which validates every field
    // and rejects the whole submission if one is wrong. Bots are included on
    // purpose: they were in the match, and the leaderboard aggregate already
    // filters on is_bot = false.
    const sim = this.sim;
    const ended = Date.now();
    const duration = sim ? Math.max(0, Math.round(sim.matchTime)) : 0;
    const winner = sim && sim.over && typeof sim.over.winner === 'number' ? sim.over.winner : null;

    const payload = {
      match: {
        room_code: this.room.code,
        mode: this.room.mode,
        seed: this.matchSeed(),
        started_at: new Date(ended - duration * 1000).toISOString(),
        ended_at: new Date(ended).toISOString(),
        duration_seconds: duration,
        winning_team: winner,
        wave_reached: sim ? sim.director.wave : 0
      },
      // Someone who dropped, lost their grace window and rejoined played the
      // same match under two player ids. `match_players` has a unique index on
      // (match_id, profile_id), so the second row would reject the whole
      // submission — the first appearance wins and the rest go in as guests.
      players: results.map((r, i) => ({
        // A guest has no profile row, and an authId that is not a uuid would
        // 422 the entire submission on everyone else's behalf. Guests submit
        // as null and land in the match record without a leaderboard entry.
        profile_id: (!r.bot && isUuid(r.authId) && firstIndexOfAuth(results, r.authId) === i) ? r.authId : null,
        display_name: r.name,
        is_bot: r.bot,
        team: r.team,
        kills: r.kills,
        deaths: r.deaths,
        assists: r.assists,
        score: r.score,
        damage_dealt: r.damageDealt,
        accuracy: r.accuracy
      }))
    };
    const job = fetch(origin + '/api/match-result', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-overrun-secret': this.env.INTERNAL_SECRET },
      body: JSON.stringify(payload)
    }).catch(() => { /* stats are lossy by design; the match already happened */ });
    if (this.ctx.waitUntil) this.ctx.waitUntil(job);
  }

  async report() {
    try {
      const mm = this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName('global'));
      await mm.report(this.room.code, {
        mode: this.room.mode,
        state: this.room.state,
        players: this.humanCount(), maxPlayers: this.capacity()
      });
    } catch { /* the directory is a convenience, not a dependency */ }
  }

  /* -------------------------------------------------------------- SMALL */

  ensureSim() {
    // Built lazily so a lobby can hand out world geometry without paying for a
    // simulation nobody is stepping yet.
    if (!this.sim) this.sim = this.createSim();
    return this.sim;
  }

  createSim() {
    return new Sim({
      seed: this.matchSeed(), mode: this.room.mode, partySize: this.room.targetPlayers,
      vehicleDefense: !!this.room.targetPlayers, authoritative: true
    });
  }

  matchSeed() {
    return ((this.room.seed ^ ((this.room.rematch || 0) * 0x9E3779B1)) >>> 0);
  }

  nextPlayerId() {
    // Small ints, because the snapshot spends two bytes per player id and the
    // client indexes arrays with them. Wraps well before it can collide with a
    // live player in an 8-slot room.
    const id = this.room.nextPid || 1;
    this.room.nextPid = id >= 250 ? 1 : id + 1;
    this.save();
    return id;
  }

  capacity() { return this.room?.targetPlayers || (MODES[this.room?.mode] || MODES.coop).maxPlayers; }

  humanCount() {
    return this.ctx.getWebSockets().filter(ws => ws.deserializeAttachment()?.playerId).length + this.ghosts.size;
  }

  ghostByAuth(authId) {
    for (const g of this.ghosts.values()) if (g.authId && g.authId === authId) return g;
    return null;
  }

  socketFor(playerId) {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att && att.playerId === playerId) return ws;
    }
    return null;
  }

  scratchFor(ws) {
    let s = this.scratch.get(ws);
    if (!s) { s = { lastChat: 0, windowStart: 0, inputs: 0 }; this.scratch.set(ws, s); }
    return s;
  }

  /** Sliding one-second budget. Over quota returns false and the packet is
   *  dropped — no kick, no warning, no state change. */
  allowInput(ws) {
    const s = this.scratchFor(ws);
    const now = Date.now();
    if (now - s.windowStart >= 1000) { s.windowStart = now; s.inputs = 0; }
    if (s.inputs >= INPUT_BUDGET) return false;
    s.inputs++;
    return true;
  }

  save() {
    // Unawaited: the storage output gate already orders this write ahead of any
    // response that depends on it, and the tick has no time to wait for disk.
    this.ctx.storage.put('room', this.room).catch(() => { /* retried next write */ });
  }
}

/* ------------------------------------------------------------- HELPERS */

/** `Writer.bytes()` returns a subarray of an over-allocated buffer; sending it
 *  directly would put the whole allocation on the wire. */
function toBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function cleanName(raw) {
  let out = '';
  for (const ch of String(raw || '')) {
    const c = ch.codePointAt(0);
    if (c >= 0x20 && c !== 0x7f) out += ch;
    if (out.length >= 18) break;
  }
  return out.trim() || 'RUNNER';
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v) || 0);
  return n < lo ? lo : n > hi ? hi : n;
}

function botName(id) {
  return 'BOT-' + String(id).padStart(2, '0');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

function firstIndexOfAuth(results, authId) {
  return results.findIndex(r => !r.bot && r.authId === authId);
}
