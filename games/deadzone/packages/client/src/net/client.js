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

/* ============================== NET CLIENT ==============================

   Talks to a MatchRoom Durable Object over one binary WebSocket.

   Three techniques, and the reason for each:

   1. CLIENT-SIDE PREDICTION. Your own player is simulated locally the instant
      you press a key, using the same shared code the server runs. Waiting for
      a round trip before you move is the single most noticeable thing a
      netcode can get wrong, and at 120ms from Tehran to an EU edge it would
      be unplayable.

   2. SERVER RECONCILIATION. Every input carries a sequence number. The server
      echoes back the last sequence it processed alongside its authoritative
      position. The client rewinds to that position and replays every input
      the server has not yet seen. If the result matches what was already on
      screen — which it does almost always — nothing visibly happens.

   3. ENTITY INTERPOLATION. Everything that is not you is rendered 100ms in
      the past, between two received snapshots. Rendering remote players at
      the newest known position looks jittery; rendering them slightly late
      looks perfect. The 100ms is bought back by lag compensation on the
      server, which rewinds the world when it tests your shots.

   The clock offset is estimated from ping round trips with a rolling minimum,
   because the minimum RTT is the only sample not polluted by queueing.      */

import {
  MSG, Reader, encodeInput, decodeSnapshot, decodeEvents, decodeJson, encodeJson
} from '@overrun/shared/protocol.js';
import { T } from '@overrun/shared/constants.js';

export class NetClient {
  constructor(handlers) {
    this.h = handlers;
    this.ws = null;
    this.playerId = null;
    this.state = 'idle';
    this.snapshots = [];
    this.maxSnapshots = 24;
    this.seq = 0;
    this.pendingInputs = [];
    this.ping = -1;
    this.offset = 0;
    this._pingSamples = [];
    this._lastPing = 0;
    this._inputAccum = 0;
    this.serverTick = 0;
    this.closedByUs = false;
    this.reconnectAttempts = 0;
  }

  connect(url, hello) {
    this.closedByUs = false;
    this.url = url;
    this.hello = hello;
    this.state = 'connecting';

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.state = 'handshake';
      this.reconnectAttempts = 0;
      this.send(encodeJson(MSG.HELLO, hello));
    };
    ws.onmessage = (ev) => {
      try { this._onMessage(ev.data); }
      catch (e) { console.warn('[net] bad message', e); }
    };
    ws.onclose = (e) => {
      this.state = 'closed';
      this.h.onClose && this.h.onClose(e.code, e.reason);
      if (!this.closedByUs && this.reconnectAttempts < 4) {
        // Exponential backoff. A phone that switched from wifi to cellular
        // gets its character back because the server holds the body for 30s.
        const delay = 400 * Math.pow(2, this.reconnectAttempts++);
        setTimeout(() => this.connect(this.url, this.hello), delay);
      }
    };
    ws.onerror = () => { /* onclose always follows; nothing useful to add here */ };
  }

  close() {
    this.closedByUs = true;
    if (this.ws) { try { this.ws.close(); } catch (e) { void e; } }
    this.ws = null;
    this.state = 'idle';
  }

  send(bytes) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(bytes);
  }

  _onMessage(data) {
    const buf = new Uint8Array(data);
    const r = new Reader(buf);
    const type = r.u8();

    switch (type) {
      case MSG.WELCOME: {
        const w = decodeJson(r);
        this.playerId = w.playerId;
        this.state = 'ready';
        this.h.onWelcome(w);
        break;
      }
      case MSG.SNAPSHOT: {
        const s = decodeSnapshot(r);
        s.recvAt = performance.now();
        this.serverTick = s.tick;
        this.snapshots.push(s);
        while (this.snapshots.length > this.maxSnapshots) this.snapshots.shift();
        this.h.onSnapshot(s);
        break;
      }
      case MSG.EVENTS: {
        const list = decodeEvents(r);
        this.h.onEvents(list);
        break;
      }
      case MSG.PONG: {
        const p = decodeJson(r);
        const rtt = performance.now() - p.t;
        this._pingSamples.push(rtt);
        if (this._pingSamples.length > 8) this._pingSamples.shift();
        // Rolling minimum: queueing delay inflates every sample except the
        // best one, so the best one is the only honest estimate.
        this.ping = Math.round(Math.min(...this._pingSamples));
        this.offset = p.s + this.ping / 2 - performance.now();
        break;
      }
      case MSG.LOBBY: this.h.onLobby(decodeJson(r)); break;
      case MSG.CHOICE: this.h.onChoice(decodeJson(r)); break;
      case MSG.END: this.h.onEnd(decodeJson(r)); break;
      case MSG.CHATOUT: this.h.onChat && this.h.onChat(decodeJson(r)); break;
      case MSG.KICK: this.h.onKick && this.h.onKick(decodeJson(r)); break;
      default: break;
    }
  }

  /* ------------------------------------------------------------ SENDING */

  /** Called every simulation step. Ships input at T.sim.inputHz, not at frame
   *  rate: a 144Hz desktop should not send five times what a phone sends. */
  pushInput(input, dt) {
    if (this.state !== 'ready') return null;
    this._inputAccum += dt;
    const period = 1 / T.sim.inputHz;
    if (this._inputAccum < period) return null;
    this._inputAccum -= period;

    this.seq = (this.seq + 1) & 0xffff;
    const rec = { seq: this.seq, input: { ...input }, dt: period };
    this.pendingInputs.push(rec);
    if (this.pendingInputs.length > 90) this.pendingInputs.shift();
    this.send(encodeInput(this.seq, input));
    return rec;
  }

  tickPing(now) {
    if (this.state !== 'ready') return;
    if (now - this._lastPing < T.net.pingInterval * 1000) return;
    this._lastPing = now;
    this.send(encodeJson(MSG.PING, { t: performance.now() }));
  }

  sendPick(pick) { this.send(encodeJson(MSG.PICK, pick)); }
  sendReady(ready) { this.send(encodeJson(MSG.READY, { ready })); }
  sendChat(text) { this.send(encodeJson(MSG.CHAT, { text })); }

  /* ------------------------------------------------------ RECONCILIATION */

  /** Drop the inputs the server has already applied. Whatever is left is what
   *  still has to be replayed on top of the authoritative position. */
  ackInputs(seq) {
    while (this.pendingInputs.length && seqLE(this.pendingInputs[0].seq, seq)) {
      this.pendingInputs.shift();
    }
    return this.pendingInputs;
  }

  /* ------------------------------------------------------- INTERPOLATION */

  /** Find the two snapshots that straddle `renderTime` and return both plus
   *  the blend factor. Returns null while there is not yet enough history. */
  interpolationWindow(nowMs) {
    const target = nowMs - T.net.interpDelay * 1000;
    const s = this.snapshots;
    if (s.length < 2) return null;
    for (let i = s.length - 1; i > 0; i--) {
      if (s[i - 1].recvAt <= target && s[i].recvAt >= target) {
        const span = s[i].recvAt - s[i - 1].recvAt || 1;
        return { a: s[i - 1], b: s[i], t: (target - s[i - 1].recvAt) / span };
      }
    }
    // Behind the buffer: extrapolate a little from the newest pair rather than
    // freezing, but never further than maxExtrapolate.
    const last = s[s.length - 1], prev = s[s.length - 2];
    const span = last.recvAt - prev.recvAt || 1;
    const over = (target - last.recvAt) / span;
    if (over > 0) {
      const cap = (T.net.maxExtrapolate * 1000) / span;
      return { a: prev, b: last, t: 1 + Math.min(over, cap) };
    }
    return { a: prev, b: last, t: 0 };
  }
}

/** 16-bit sequence comparison that survives wraparound. */
function seqLE(a, b) {
  return ((b - a) & 0xffff) < 0x8000;
}
