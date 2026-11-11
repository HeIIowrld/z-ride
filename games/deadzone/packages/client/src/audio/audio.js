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

/* ================================ AUDIO =================================

   Forty-odd distinct sounds, a convolution reverb, a real mix bus and four
   layers of adaptive music — and not one audio file.

   Everything is rendered into AudioBuffers at load time using an
   OfflineAudioContext, which is the important difference from the old
   version. The old game synthesised every shot live: cheap, but it meant a
   gunshot was one oscillator and one noise burst, and no amount of parameter
   jitter makes that sound like a gun. Rendering offline means each sound can
   be a properly layered construction — transient, body, tail, mechanical
   detail — and then each variant costs a single buffer playback at runtime.

   Six variants of each impactful sound are baked, chosen at random and
   pitch-shifted, so sustained fire never turns into a loop. That is the whole
   trick to making a 60-round magazine sound like sixty rounds.

   Mix architecture:

       voice -> panner -> [sfxBus] -\
                                     +-> compressor -> limiter -> out
       reverbSend -> convolver ------/
       music  -> [musicBus, ducked] -/

   The music bus sidechains under every explosion, and a low-pass on the whole
   sfx bus closes when the player is nearly dead. Both are arousal levers with
   measurable effects on how a fight feels, and both are free.               */

/* The rate everything is synthesised at.

   This used to be a hard 44100, which was wrong in a way that only shows up on
   hardware that does not happen to run at 44.1 kHz. Two separate problems:

   AudioBufferSourceNode resamples a mismatched buffer silently, so the sound
   effects merely lost a little of the transient detail they were tuned for —
   invisible, and survivable. ConvolverNode does NOT resample: handed an
   impulse response at a rate other than the context's, Chrome throws
   NotSupportedError. That threw during audio init, and because init was
   awaited on the path that starts a match, the exception took the whole game
   down with it. On a 96 kHz interface the game could not be started at all.

   So the rate is decided at init from the live context, and the impulse
   response is built on the live context directly, where a mismatch is not
   representable. `let`, not `const`: the render helpers below read this at
   call time and must see the value chosen for the device in front of us. */
let SR = 44100;

/* Safari has historically refused OfflineAudioContext at anything other than
   44100. Rather than detect browsers, ask: construct a one-frame context at
   each candidate rate and take the first that is accepted. Falling back costs
   only resampling on playback, which is what the old code did unconditionally. */
function pickRenderRate(preferred) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return 44100;
  for (const rate of [preferred, 48000, 44100]) {
    if (!rate) continue;
    try {
      new OAC(1, 1, rate);
      return rate;
    } catch (e) { void e; }
  }
  return 44100;
}

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.ready = false;
    // Set once if init throws, so a device with a hostile audio stack is not
    // asked to rebuild the whole engine on every button press.
    this.failed = false;
    this.buffers = new Map();
    this.voices = 0;
    this.maxVoices = 32;
    this.listener = { x: 0, z: 0, a: 0 };
    this.musicOn = false;
    this.intensity = 0;
    this._nextNote = 0;
    this._step = 0;
    this._chord = 0;
    this._lastFootstep = 0;
  }

  /** Must be called from a user gesture. Returns a promise that resolves once
   *  every buffer is baked; the game is playable before it resolves.
   *
   *  Never rejects, by contract. Callers await this on the path that starts a
   *  match, so a rejection here is a game that does not start — which is
   *  exactly what shipped when a 44.1 kHz impulse response met a 48 kHz
   *  context. Failure belongs to the audio engine and stops here: the worst
   *  outcome is a silent game. Handling it in the engine rather than at one
   *  call site means every caller is covered, including future ones. */
  async init() {
    if (this.ready || this.failed) return;
    try {
      await this._init();
    } catch (e) {
      this.failed = true;
      this.ready = false;
      console.error('[audio] disabled: initialisation failed', e);
    }
  }

  async _init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });

    // Before anything is synthesised: everything below bakes at SR.
    SR = pickRenderRate(ctx.sampleRate);

    this.master = ctx.createGain();
    this.master.gain.value = 0.85;

    // Limiter first, then a gentle glue compressor. Order matters: the limiter
    // is there to stop forty simultaneous impacts clipping, the compressor is
    // there to make the mix feel dense.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;

    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -16;
    glue.knee.value = 8;
    glue.ratio.value = 4;
    glue.attack.value = 0.004;
    glue.release.value = 0.2;

    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 20000;

    this.sfxBus = ctx.createGain(); this.sfxBus.gain.value = 0.9;
    this.uiBus = ctx.createGain(); this.uiBus.gain.value = 0.6;
    this.musicBus = ctx.createGain(); this.musicBus.gain.value = 0;

    // Convolution reverb. A concrete yard: bright, medium decay, audible
    // slapback off the perimeter wall.
    this.sfxBus.connect(this.lowpass);

    // Reverb is a garnish, so it is wired defensively and separately: if the
    // convolver cannot be built the dry path above is already connected and
    // the game still has sound. This used to be inline and unguarded, and a
    // throw here was enough to stop a match from starting.
    try {
      this.convolver = ctx.createConvolver();
      this.convolver.buffer = makeImpulse(ctx, 1.9, 2.6, 0.55);
      this.reverbSend = ctx.createGain();
      this.reverbSend.gain.value = 0.24;
      this.reverbReturn = ctx.createGain();
      this.reverbReturn.gain.value = 0.5;

      this.sfxBus.connect(this.reverbSend);
      this.reverbSend.connect(this.convolver);
      this.convolver.connect(this.reverbReturn);
      this.reverbReturn.connect(this.lowpass);
    } catch (e) {
      console.warn('[audio] reverb unavailable, running dry', e);
      this.convolver = null;
      this.reverbSend = null;
      this.reverbReturn = null;
    }

    this.uiBus.connect(glue);
    this.musicBus.connect(glue);
    this.lowpass.connect(glue);
    glue.connect(limiter);
    limiter.connect(this.master);
    this.master.connect(ctx.destination);

    this.ready = true;
    await this.bake();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  /* ------------------------------------------------------------- BAKING */

  async bake() {
    const jobs = [];
    // One sound that fails to render costs that sound and nothing else.
    // play() already treats a missing buffer as silence, so the failure mode
    // is a gap in the mix rather than a game with no audio at all.
    const add = (name, dur, fn) => jobs.push(
      renderOffline(dur, fn)
        .then(b => { if (b) this.buffers.set(name, b); })
        .catch(e => console.warn(`[audio] could not bake "${name}"`, e))
    );

    // Six variants of each weapon report. The variation lives in the noise
    // seed and the transient shape, not only in pitch, which is why they read
    // as different rounds rather than the same round tuned up.
    for (let v = 0; v < 6; v++) {
      add(`smg${v}`, 0.30, (c, t) => gunshot(c, t, {
        bodyFreq: 190 + v * 9, bodyDecay: 0.055, noiseDecay: 0.075,
        bright: 5200 + v * 260, punch: 0.62, mech: 0.30, tail: 0.16
      }));
      add(`shot${v}`, 0.75, (c, t) => gunshot(c, t, {
        bodyFreq: 84 + v * 4, bodyDecay: 0.19, noiseDecay: 0.26,
        bright: 3300 + v * 200, punch: 1.0, mech: 0.55, tail: 0.5, sub: true
      }));
      add(`rail${v}`, 0.9, (c, t) => railshot(c, t, v));
      add(`arc${v}`, 0.42, (c, t) => gunshot(c, t, {
        bodyFreq: 420 + v * 20, bodyDecay: 0.08, noiseDecay: 0.10,
        bright: 7000, punch: 0.5, mech: 0.2, tail: 0.28, metallic: true
      }));
      add(`thump${v}`, 0.8, (c, t) => gunshot(c, t, {
        bodyFreq: 110 + v * 5, bodyDecay: 0.14, noiseDecay: 0.2,
        bright: 2400, punch: 0.9, mech: 0.7, tail: 0.45, sub: true
      }));
      add(`impact${v}`, 0.28, (c, t) => impact(c, t, v, false));
      add(`crit${v}`, 0.36, (c, t) => impact(c, t, v, true));
      add(`step${v}`, 0.22, (c, t) => footstep(c, t, v));
      add(`hurt${v}`, 0.45, (c, t) => hurt(c, t, v));
    }

    add('beam', 0.5, (c, t) => beamLoop(c, t));
    add('explodeS', 1.4, (c, t) => explosion(c, t, false));
    add('explodeL', 2.4, (c, t) => explosion(c, t, true));
    add('dash', 0.4, (c, t) => dash(c, t));
    add('shieldBreak', 0.6, (c, t) => shieldBreak(c, t));
    add('pickup', 0.3, (c, t) => pickup(c, t, false));
    add('health', 0.5, (c, t) => pickup(c, t, true));
    add('uiTick', 0.10, (c, t) => uiBlip(c, t, 720, 0.045));
    add('uiOk', 0.22, (c, t) => uiChord(c, t, [660, 880, 1320]));
    add('uiBack', 0.18, (c, t) => uiChord(c, t, [420, 330]));
    add('waveStart', 1.6, (c, t) => waveHorn(c, t));
    add('waveClear', 1.8, (c, t) => waveClear(c, t));
    add('telegraph', 0.5, (c, t) => telegraph(c, t));
    add('spawnWarn', 0.4, (c, t) => spawnWarn(c, t));
    add('abilityCast', 0.9, (c, t) => abilityCast(c, t));
    add('levelUp', 1.6, (c, t) => levelUp(c, t));
    add('streak', 1.0, (c, t) => streak(c, t));
    add('down', 1.2, (c, t) => downed(c, t));
    add('revive', 1.0, (c, t) => revive(c, t));
    add('enemyShot', 0.35, (c, t) => enemyShot(c, t));
    add('enemyDie', 0.5, (c, t) => enemyDie(c, t));
    add('eliteDie', 1.2, (c, t) => eliteDie(c, t));
    add('shell', 0.35, (c, t) => shellCasing(c, t));
    add('reloadClick', 0.2, (c, t) => uiBlip(c, t, 240, 0.03, 'square'));

    await Promise.all(jobs);
  }

  /* -------------------------------------------------------------- VOICES */

  setListener(x, z, a) { this.listener.x = x; this.listener.z = z; this.listener.a = a; }

  _take() {
    if (this.voices >= this.maxVoices) return false;
    this.voices++;
    return true;
  }

  /** Play a baked buffer at a world position. */
  play(name, opts = {}) {
    if (!this.ready || !this.settings.sfx) return null;
    const buf = this.buffers.get(name);
    if (!buf) return null;
    if (!opts.ui && !this._take()) return null;

    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 1;

    const g = ctx.createGain();
    g.gain.value = opts.gain ?? 1;

    let node = src;
    if (opts.filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = opts.filter;
      node.connect(f);
      node = f;
    }
    node.connect(g);

    if (opts.ui) {
      g.connect(this.uiBus);
    } else if (opts.x !== undefined) {
      // Distance attenuation and stereo placement relative to the player.
      // Full HRTF panning costs more than it is worth on a top-down game.
      const dx = opts.x - this.listener.x;
      const dz = opts.z - this.listener.z;
      const d = Math.hypot(dx, dz);
      const att = Math.max(0.04, 1 - d / 62);
      g.gain.value *= att * att;
      // Distant sounds lose their top end. This one line does more for depth
      // than the reverb does.
      if (d > 12 && !opts.filter) {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = Math.max(700, 18000 - d * 260);
        g.disconnect();
        g.connect(f);
        node = f;
      }
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-0.92, Math.min(0.92, dx / 24));
      (node === src || node.numberOfOutputs ? g : g).connect(p);
      try { g.disconnect(); } catch (e) { void e; }
      g.connect(p);
      p.connect(this.sfxBus);
    } else {
      g.connect(this.sfxBus);
    }

    src.start();
    const dur = buf.duration / (opts.rate ?? 1);
    if (!opts.ui) setTimeout(() => { this.voices = Math.max(0, this.voices - 1); }, dur * 1000);
    return src;
  }

  variant(base, opts) {
    const v = (Math.random() * 6) | 0;
    return this.play(base + v, { rate: 0.94 + Math.random() * 0.12, ...opts });
  }

  /* ------------------------------------------------------- GAME SOUNDS */

  shot(weaponId, x, z) {
    const map = { smg: 'smg', shotgun: 'shot', rail: 'rail', arc: 'arc', launcher: 'thump', beam: null };
    const base = map[weaponId];
    if (base === null) { this.play('beam', { x, z, gain: 0.5, rate: 0.9 + Math.random() * 0.2 }); return; }
    this.variant(base || 'smg', { x, z, gain: 1 });
    if (weaponId === 'smg' || weaponId === 'shotgun') {
      // Brass on concrete, slightly late. The detail nobody notices and
      // everybody misses.
      setTimeout(() => this.play('shell', { x, z, gain: 0.32, rate: 0.9 + Math.random() * 0.3 }), 120 + Math.random() * 90);
    }
  }

  hit(x, z, crit) { this.variant(crit ? 'crit' : 'impact', { x, z, gain: crit ? 1 : 0.75 }); }
  hurt(x, z) { this.variant('hurt', { x, z, gain: 1 }); }
  footstep(intensity) {
    const now = performance.now();
    if (now - this._lastFootstep < 90) return;
    this._lastFootstep = now;
    this.variant('step', { gain: 0.18 + intensity * 0.3, rate: 0.9 + Math.random() * 0.25 });
  }
  explode(x, z, big) {
    this.play(big ? 'explodeL' : 'explodeS', { x, z, gain: big ? 1 : 0.8 });
    this.duck(big ? 0.6 : 0.32);
  }
  dash(x, z) { this.play('dash', { x, z, gain: 0.7 }); }
  pickup(kind) { this.play(kind === 'health' ? 'health' : 'pickup', { gain: 0.55, ui: true }); }
  ui(kind) {
    const m = { tick: 'uiTick', ok: 'uiOk', back: 'uiBack' };
    this.play(m[kind] || 'uiTick', { ui: true, gain: 0.7 });
  }
  wave(clear) { this.play(clear ? 'waveClear' : 'waveStart', { gain: 0.8, ui: true }); this.duck(0.4); }
  telegraph(x, z) { this.play('telegraph', { x, z, gain: 0.55 }); }
  spawnWarn(x, z) { this.play('spawnWarn', { x, z, gain: 0.35 }); }
  ability(x, z) { this.play('abilityCast', { x, z, gain: 0.9 }); this.duck(0.35); }
  enemyShot(x, z) { this.play('enemyShot', { x, z, gain: 0.6, rate: 0.9 + Math.random() * 0.25 }); }

  /** The kill pitch ladder. One line, and it does more for retention than any
   *  menu in the game: each kill in a combo is a semitone higher than the
   *  last, so a streak literally resolves upward. */
  kill(comboStep, x, z, elite) {
    if (elite) { this.play('eliteDie', { x, z, gain: 0.9 }); return; }
    const semis = Math.min(comboStep, 24) * 1.0;
    this.play('enemyDie', { x, z, gain: 0.7, rate: Math.pow(2, semis / 12) * (0.96 + Math.random() * 0.08) });
  }

  streak() { this.play('streak', { gain: 0.8, ui: true }); this.duck(0.35); }
  levelUp() { this.play('levelUp', { gain: 0.9, ui: true }); this.duck(0.5); }
  down() { this.play('down', { gain: 0.9, ui: true }); this.duck(0.6); }
  revive() { this.play('revive', { gain: 0.85, ui: true }); }
  shieldBreak(x, z) { this.play('shieldBreak', { x, z, gain: 0.8 }); }

  /** Sidechain: everything ducks under the loud thing. */
  duck(amount) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const g = this.musicBus.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(Math.max(0.015, g.value * (1 - amount)), t + 0.03);
    g.linearRampToValueAtTime(this.musicTarget(), t + 0.45);
  }

  musicTarget() {
    return this.settings.music && this.musicOn ? 0.16 + this.intensity * 0.16 : 0;
  }

  /** Low health: the world goes muffled and you know it before you read a bar. */
  setLowHealth(on) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.lowpass.frequency.cancelScheduledValues(t);
    this.lowpass.frequency.setValueAtTime(this.lowpass.frequency.value, t);
    this.lowpass.frequency.linearRampToValueAtTime(on ? 850 : 20000, t + 0.35);
    // Only if the reverb was actually built — it is optional now.
    if (this.reverbReturn) this.reverbReturn.gain.linearRampToValueAtTime(on ? 0.9 : 0.5, t + 0.35);
  }

  /* --------------------------------------------------------------- MUSIC */

  /** Four synth layers whose density, register and tempo all follow the
   *  director's intensity. Layers enter at thresholds rather than crossfading
   *  continuously, because an arrangement that *changes* is noticed and an
   *  arrangement that merely gets louder is not. */
  tickMusic(intensity) {
    if (!this.ready || !this.settings.music || !this.musicOn) return;
    this.intensity = intensity;
    const ctx = this.ctx;
    const bpm = 92 + intensity * 52;
    const spb = 60 / bpm / 2;

    if (this._nextNote < ctx.currentTime) this._nextNote = ctx.currentTime + 0.06;
    while (this._nextNote < ctx.currentTime + 0.2) {
      const t = this._nextNote;
      const s = this._step % 16;
      const root = 55 * Math.pow(2, this._chord / 12);

      // Layer 1: the pulse. Always present, it is the heartbeat.
      if (s % 4 === 0) this.note(root, t, spb * 2.7, 'sine', 0.50);
      if (s % 8 === 4) this.note(root * 0.5, t, spb * 1.6, 'sine', 0.35);

      // Layer 2: sub-bass on the offbeat. Enters early.
      if (intensity > 0.18 && s % 2 === 0) {
        this.note(root * 2 * (s % 8 === 6 ? 1.5 : 1), t, spb * 1.05, 'triangle', 0.20);
      }
      // Layer 3: the arp. This is the one that tells you it has got serious.
      if (intensity > 0.48) {
        const seq = [1, 1.5, 1.25, 2, 1.5, 1.25, 1, 1.5];
        this.note(root * 8 * seq[(this._step >> 1) % 8], t, spb * 0.65, 'sawtooth', 0.055);
      }
      // Layer 4: a held pad up top, only when it is genuinely bad.
      if (intensity > 0.78 && s === 0) {
        this.note(root * 6, t, spb * 12, 'sawtooth', 0.028, 900);
      }

      this._step++;
      if (this._step % 32 === 0) {
        // A four-chord loop that never resolves. Unresolved is the point.
        this._chord = [0, 0, 3, 5, -2, 7][(Math.random() * 6) | 0];
      }
      this._nextNote += spb;
    }

    const g = this.musicBus.gain;
    const tgt = this.musicTarget();
    if (Math.abs(g.value - tgt) > 0.01) g.setTargetAtTime(tgt, ctx.currentTime, 0.7);
  }

  note(f, t, d, type, v, cutoff) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v), t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    let node = o;
    if (cutoff) {
      const f2 = ctx.createBiquadFilter();
      f2.type = 'lowpass';
      f2.frequency.setValueAtTime(cutoff, t);
      f2.Q.value = 3;
      o.connect(f2);
      node = f2;
    }
    node.connect(g);
    g.connect(this.musicBus);
    o.start(t);
    o.stop(t + d + 0.03);
  }
}

/* ======================= OFFLINE RENDER HELPERS ========================
   Each of these draws directly into a Float32Array. Writing samples by hand
   rather than wiring oscillator nodes is what makes the transients tight —
   an ADSR envelope on a node cannot do a two-millisecond attack reliably. */

function renderOffline(duration, fn) {
  const n = Math.max(1, Math.ceil(SR * duration));
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return Promise.resolve(null);
  const octx = new OAC(1, n, SR);
  const buf = octx.createBuffer(1, n, SR);
  const data = buf.getChannelData(0);
  fn(data, n);
  // Universal 3ms fade-out: a buffer that ends mid-cycle clicks, every time.
  const fade = Math.min(n, Math.floor(SR * 0.003));
  for (let i = 0; i < fade; i++) data[n - 1 - i] *= i / fade;
  return Promise.resolve(buf);
}

const rnd = () => Math.random() * 2 - 1;
const env = (i, n, attack, decay) => {
  const t = i / SR;
  if (t < attack) return t / attack;
  return Math.exp(-(t - attack) / decay);
};

function gunshot(d, n, o) {
  let lp = 0, hp = 0, prev = 0;
  const bodyW = (o.bodyFreq * 2 * Math.PI) / SR;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // Transient: a very short, very bright noise crack.
    const crack = rnd() * Math.exp(-t / 0.004) * o.punch * 1.4;
    // Body: a filtered noise burst sweeping down, the actual "boom".
    const cutoff = o.bright * Math.exp(-t / o.noiseDecay) + 220;
    const a = Math.min(1, (2 * Math.PI * cutoff) / SR);
    lp += a * (rnd() - lp);
    const body = lp * env(i, n, 0.001, o.noiseDecay) * o.punch;
    // Tonal thump, detuned slightly per shot.
    const tone = Math.sin(bodyW * i * (1 - t * 0.6)) * Math.exp(-t / o.bodyDecay) * 0.5;
    // Sub for the heavy weapons: felt more than heard.
    const sub = o.sub ? Math.sin((2 * Math.PI * 48 * i) / SR) * Math.exp(-t / 0.14) * 0.7 : 0;
    // Mechanical action: a short metallic ring after the report.
    const mech = t > 0.02
      ? Math.sin((2 * Math.PI * (o.metallic ? 2400 : 1650) * i) / SR) * Math.exp(-(t - 0.02) / 0.03) * o.mech * 0.25
      : 0;
    // Tail: room decay, high-passed so it does not muddy the body.
    const raw = rnd() * Math.exp(-t / (o.tail + 0.001)) * 0.16;
    hp = 0.94 * (hp + raw - prev);
    prev = raw;
    d[i] = softclip((crack + body + tone + sub + mech + hp * o.tail) * 0.82);
  }
}

function railshot(d, n, v) {
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // A rising charge that snaps into a bright discharge.
    const chargeF = 220 + t * 2400 + v * 40;
    const charge = t < 0.22 ? Math.sin((2 * Math.PI * chargeF * i) / SR) * (t / 0.22) * 0.25 : 0;
    const st = t - 0.22;
    let fire = 0;
    if (st >= 0) {
      const sweep = 3000 * Math.exp(-st / 0.05) + 140;
      fire = (Math.sin((2 * Math.PI * sweep * i) / SR) * 0.55 + rnd() * 0.4) * Math.exp(-st / 0.10);
      fire += Math.sin((2 * Math.PI * 62 * i) / SR) * Math.exp(-st / 0.2) * 0.6;
      fire += rnd() * Math.exp(-st / 0.55) * 0.10;   // long bright tail
    }
    d[i] = softclip((charge + fire) * 0.9);
  }
}

function impact(d, n, v, crit) {
  const f = (crit ? 340 : 210) + v * 26;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const cut = (crit ? 5200 : 3000) * Math.exp(-t / 0.02) + 300;
    lp += Math.min(1, (2 * Math.PI * cut) / SR) * (rnd() - lp);
    const noise = lp * Math.exp(-t / (crit ? 0.05 : 0.03));
    const tone = Math.sin((2 * Math.PI * f * i) / SR * (1 - t * 1.5)) * Math.exp(-t / 0.045) * (crit ? 0.7 : 0.4);
    // A crit adds a bright metallic ping so it is audible in a crowd.
    const ping = crit ? Math.sin((2 * Math.PI * 2100 * i) / SR) * Math.exp(-t / 0.09) * 0.30 : 0;
    d[i] = softclip((noise + tone + ping) * 0.85);
  }
}

function footstep(d, n, v) {
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const cut = (1400 + v * 180) * Math.exp(-t / 0.012) + 160;
    lp += Math.min(1, (2 * Math.PI * cut) / SR) * (rnd() - lp);
    const grit = rnd() * Math.exp(-t / 0.05) * 0.10;   // scuff on concrete
    d[i] = softclip((lp * Math.exp(-t / 0.028) * 1.1 + grit) * 0.7);
  }
}

function hurt(d, n, v) {
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = (150 - v * 8) * (1 - t * 0.8);
    const grind = Math.sin((2 * Math.PI * f * i) / SR) * Math.exp(-t / 0.12) * 0.55;
    const harm = Math.sin((2 * Math.PI * f * 2.5 * i) / SR) * Math.exp(-t / 0.06) * 0.20;
    const air = rnd() * Math.exp(-t / 0.16) * 0.22;
    d[i] = softclip((grind + harm + air) * 0.9);
  }
}

function explosion(d, n, big) {
  let lp = 0, lp2 = 0;
  const decay = big ? 0.55 : 0.28;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const cut = (big ? 2400 : 3200) * Math.exp(-t / (decay * 0.4)) + 90;
    lp += Math.min(1, (2 * Math.PI * cut) / SR) * (rnd() - lp);
    lp2 += 0.02 * (lp - lp2);                             // rumble
    const boom = Math.sin((2 * Math.PI * (big ? 40 : 62) * i) / SR * (1 - t * 0.4)) * Math.exp(-t / (big ? 0.42 : 0.22));
    const crack = rnd() * Math.exp(-t / 0.006) * 0.8;
    const debris = t > 0.1 && Math.random() < 0.0016 ? rnd() * 0.5 : 0;   // scattered fragments
    d[i] = softclip((lp * Math.exp(-t / decay) * 1.2 + boom * 1.1 + crack + lp2 * 2.2 + debris) * 0.8);
  }
}

function dash(d, n) {
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const cut = 700 + t * 9000;
    const w = Math.min(1, (2 * Math.PI * cut) / SR);
    d[i] = softclip(rnd() * w * Math.exp(-Math.abs(t - 0.06) / 0.05) * 1.6
      + Math.sin((2 * Math.PI * (420 + t * 1600) * i) / SR) * Math.exp(-t / 0.09) * 0.22);
  }
}

function shieldBreak(d, n) {
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let g = 0;
    for (const f of [1180, 1560, 2340, 3120]) g += Math.sin((2 * Math.PI * f * i) / SR) * 0.16;
    d[i] = softclip((g * Math.exp(-t / 0.14) + rnd() * Math.exp(-t / 0.05) * 0.3) * 0.9);
  }
}

function pickup(d, n, health) {
  const notes = health ? [523, 659, 784, 1047] : [880, 1320];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let g = 0;
    for (let k = 0; k < notes.length; k++) {
      const start = k * (health ? 0.055 : 0.035);
      if (t < start) continue;
      g += Math.sin((2 * Math.PI * notes[k] * i) / SR) * Math.exp(-(t - start) / 0.09) * 0.28;
    }
    d[i] = softclip(g);
  }
}

function uiBlip(d, n, f, decay, type = 'sine') {
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const ph = (2 * Math.PI * f * i) / SR;
    const s = type === 'square' ? Math.sign(Math.sin(ph)) * 0.5 : Math.sin(ph);
    d[i] = s * Math.exp(-t / decay) * 0.5;
  }
}

function uiChord(d, n, freqs) {
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let g = 0;
    for (let k = 0; k < freqs.length; k++) {
      const start = k * 0.028;
      if (t < start) continue;
      g += Math.sin((2 * Math.PI * freqs[k] * i) / SR) * Math.exp(-(t - start) / 0.07) * 0.26;
    }
    d[i] = softclip(g);
  }
}

function waveHorn(d, n) {
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 110 * (1 + Math.min(1, t / 0.5) * 0.5);
    let g = 0;
    for (let h = 1; h <= 5; h++) g += Math.sin((2 * Math.PI * f * h * i) / SR) / (h * 1.6);
    const swell = Math.min(1, t / 0.18) * Math.exp(-Math.max(0, t - 0.5) / 0.5);
    d[i] = softclip(g * swell * 0.45 + rnd() * swell * 0.03);
  }
}

function waveClear(d, n) {
  const notes = [392, 494, 587, 784];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let g = 0;
    for (let k = 0; k < notes.length; k++) {
      const start = k * 0.10;
      if (t < start) continue;
      g += Math.sin((2 * Math.PI * notes[k] * i) / SR) * Math.exp(-(t - start) / 0.42) * 0.22;
    }
    d[i] = softclip(g);
  }
}

function telegraph(d, n) {
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // Two short rises. Rising pitch is read as "incoming" pre-attentively.
    const f = 300 + (t % 0.22) * 2600;
    d[i] = softclip(Math.sin((2 * Math.PI * f * i) / SR) * Math.exp(-(t % 0.22) / 0.07) * 0.30);
  }
}

function spawnWarn(d, n) {
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    d[i] = softclip((Math.sin((2 * Math.PI * 180 * i) / SR) * 0.3 + rnd() * 0.18)
      * Math.exp(-t / 0.10));
  }
}

function abilityCast(d, n) {
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 240 + t * 2200;
    const swirl = Math.sin((2 * Math.PI * f * i) / SR) * 0.32;
    const shimmer = Math.sin((2 * Math.PI * (f * 2.51) * i) / SR) * 0.14;
    const air = rnd() * 0.14;
    d[i] = softclip((swirl + shimmer + air) * Math.exp(-Math.max(0, t - 0.1) / 0.28) * Math.min(1, t / 0.03));
  }
}

function levelUp(d, n) {
  const notes = [523, 659, 784, 1047, 1319];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let g = 0;
    for (let k = 0; k < notes.length; k++) {
      const start = k * 0.075;
      if (t < start) continue;
      g += Math.sin((2 * Math.PI * notes[k] * i) / SR) * Math.exp(-(t - start) / 0.5) * 0.20;
    }
    d[i] = softclip(g);
  }
}

function streak(d, n) {
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 220 * Math.pow(2, Math.min(1, t / 0.5));
    let g = 0;
    for (let h = 1; h <= 3; h++) g += Math.sin((2 * Math.PI * f * h * i) / SR) / (h * 1.8);
    d[i] = softclip(g * Math.exp(-t / 0.42) * 0.5);
  }
}

function downed(d, n) {
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 220 * (1 - t * 0.55);
    d[i] = softclip((Math.sin((2 * Math.PI * f * i) / SR) * 0.4
      + Math.sin((2 * Math.PI * f * 0.5 * i) / SR) * 0.3) * Math.exp(-t / 0.7));
  }
}

function revive(d, n) {
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 180 * (1 + t * 2.4);
    d[i] = softclip(Math.sin((2 * Math.PI * f * i) / SR) * Math.min(1, t / 0.1) * Math.exp(-Math.max(0, t - 0.3) / 0.3) * 0.4);
  }
}

function enemyShot(d, n) {
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const cut = 2600 * Math.exp(-t / 0.03) + 200;
    lp += Math.min(1, (2 * Math.PI * cut) / SR) * (rnd() - lp);
    const tone = Math.sin((2 * Math.PI * 260 * i) / SR * (1 - t * 2)) * Math.exp(-t / 0.06) * 0.4;
    d[i] = softclip((lp * Math.exp(-t / 0.05) + tone) * 0.75);
  }
}

function enemyDie(d, n) {
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 320 * (1 + t * 1.7);
    d[i] = softclip((Math.sin((2 * Math.PI * f * i) / SR) * 0.42 + rnd() * Math.exp(-t / 0.04) * 0.3)
      * Math.exp(-t / 0.13));
  }
}

function eliteDie(d, n) {
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const cut = 2200 * Math.exp(-t / 0.15) + 120;
    lp += Math.min(1, (2 * Math.PI * cut) / SR) * (rnd() - lp);
    const boom = Math.sin((2 * Math.PI * 55 * i) / SR) * Math.exp(-t / 0.35) * 0.8;
    const scream = Math.sin((2 * Math.PI * (500 - t * 300) * i) / SR) * Math.exp(-t / 0.28) * 0.3;
    d[i] = softclip((lp * Math.exp(-t / 0.3) + boom + scream) * 0.8);
  }
}

function shellCasing(d, n) {
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let g = 0;
    // Two bounces, the second quieter and later. This is the entire illusion.
    for (const [start, gain] of [[0, 1], [0.11, 0.45], [0.19, 0.2]]) {
      if (t < start) continue;
      const lt = t - start;
      g += (Math.sin((2 * Math.PI * 3100 * i) / SR) * 0.5 + Math.sin((2 * Math.PI * 4700 * i) / SR) * 0.3)
        * Math.exp(-lt / 0.012) * gain;
    }
    d[i] = softclip(g * 0.5);
  }
}

function beamLoop(d, n) {
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    lp += 0.08 * (rnd() - lp);
    const hiss = lp * 1.4;
    const roar = Math.sin((2 * Math.PI * 90 * i) / SR) * 0.25;
    const flick = Math.sin((2 * Math.PI * 7 * i) / SR) * 0.15 + 0.85;
    d[i] = softclip((hiss + roar) * flick * Math.min(1, t / 0.02) * Math.exp(-Math.max(0, t - 0.3) / 0.12) * 0.7);
  }
}

/** Exponentially decaying noise with an early-reflection cluster: a concrete
 *  yard, not a cathedral. */
function makeImpulse(ctx, seconds, decay, brightness) {
  // The live context's rate, deliberately, not SR. A ConvolverNode rejects an
  // impulse response recorded at any other rate, and unlike the sample buffers
  // there is no resampling to fall back on — it throws. Building the buffer on
  // the context that will play it makes the mismatch unrepresentable.
  const rate = ctx.sampleRate;
  const n = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, n, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      lp += brightness * (rnd() - lp);
      d[i] = lp * Math.pow(1 - t, decay);
    }
    // Slapback off the perimeter wall, ~28ms out and back.
    const tap = Math.floor(rate * 0.028) + ch * 90;
    if (tap < n) d[tap] += 0.35 * (ch ? -1 : 1);
    const tap2 = Math.floor(rate * 0.051) + ch * 130;
    if (tap2 < n) d[tap2] += 0.2;
  }
  return buf;
}

/** Tanh-ish saturation. Keeps forty simultaneous impacts from clipping while
 *  adding the harmonics that make them sound loud rather than merely large. */
function softclip(x) {
  if (x > 1.2) return 1;
  if (x < -1.2) return -1;
  return x - (x * x * x) / 3.6;
}
