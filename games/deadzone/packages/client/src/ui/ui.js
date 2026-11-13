// Modified for Z-RIDE lobby copy.
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

/* ================================== UI ==================================
   All DOM. No game logic lives here — the UI is told what is true and renders
   it, which is what lets the same HUD serve a local run, a co-op session and
   a PvP match without branching all over the place.

   Two things this file is careful about, because they are what make a HUD
   feel expensive:

     • Nothing writes to the DOM unless the value actually changed. Setting
       textContent every frame on twenty elements is a layout thrash you can
       measure on a mid-range phone.
     • Transforms only. No width/height/top/left animation anywhere; every bar
       is a scaleX on a pre-sized element.                                   */

import { T, TEAM_NAMES } from '@overrun/shared/constants.js';
import { clamp } from '@overrun/shared/math.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(app) {
    this.app = app;
    this.el = {};
    const ids = [
      'hud', 'wave', 'waveName', 'intensityFill', 'score', 'best', 'hpFill', 'shFill', 'hpNum',
      'comboNum', 'comboDecay', 'ladder', 'wName', 'wSwap', 'ab1', 'ab2', 'dashPad', 'dashPips',
      'banner', 'cards', 'reroll', 'summary', 'deathLine', 'titleHint', 'settingsList',
      'teamScores', 'matchClock', 'squadList', 'killfeed', 'minimapCv', 'indicators', 'dmgLayer',
      'reviveBar', 'downNotice', 'respawnNotice', 'nameTag', 'roomCode', 'lobbyPlayers',
      'lobbyStatus', 'lobbyMode', 'codeInput', 'joinError', 'scoreboard', 'resultTitle',
      'choiceTimer', 'modeGrid', 'howBody', 'profileStrip', 'toast', 'netbadge', 'pingText',
      'xpBar', 'xpFill', 'xpLevel', 'xpGain', 'bootFill', 'bootText', 'boot', 'debug', 'readyBtn'
    ];
    for (const id of ids) this.el[id] = $(id);

    this.cache = {};
    this.bannerT = 0;
    this.feed = [];
    this.indicatorPool = [];
    this.mm = this.el.minimapCv.getContext('2d');

    this._buildLadder();
    this._buildIndicators();
    this._bindPressFeedback();
  }

  /* Press feedback on pointer-DOWN, delegated at the document.

     :active is not good enough on touch: the browser withholds it until it has
     decided the touch is not the start of a scroll, which is a visible chunk
     of dead time on exactly the interaction that most needs to feel immediate.
     Pointerdown fires on contact. Delegation means every control gets it,
     including the mode rows and upgrade cards built at runtime, without a
     single call site having to remember.

     `.pressed` only ever drives transform and background, both of which are
     compositor-only, so this cannot cost a frame. */
  _bindPressFeedback() {
    const SEL = '.btn, .mode, .card, .tapzone, .pad';
    let held = null;
    const release = () => {
      if (held) { held.classList.remove('pressed'); held = null; }
    };
    document.addEventListener('pointerdown', e => {
      const t = e.target.closest ? e.target.closest(SEL) : null;
      if (!t || t.hasAttribute('disabled')) return;
      release();
      held = t;
      t.classList.add('pressed');
    }, { passive: true });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave', 'blur']) {
      document.addEventListener(ev, release, { passive: true });
    }
    // A pointer that slides off the control it started on should let go of it,
    // the same way a native button does.
    document.addEventListener('pointermove', e => {
      if (!held) return;
      const over = e.target.closest ? e.target.closest(SEL) : null;
      if (over !== held) release();
    }, { passive: true });
  }

  _buildLadder() {
    const lad = this.el.ladder;
    this.rungs = [];
    for (let i = 0; i < T.combo.maxRung; i++) {
      const r = document.createElement('div');
      r.className = 'rung';
      lad.insertBefore(r, lad.firstChild);
      this.rungs.push(r);
    }
  }

  _buildIndicators() {
    for (let i = 0; i < 14; i++) {
      const el = document.createElement('div');
      el.className = 'ind';
      el.style.opacity = '0';
      this.el.indicators.appendChild(el);
      this.indicatorPool.push({ el, used: false });
    }
  }

  /* ------------------------------------------------------------- helpers */

  set(id, value) {
    if (this.cache[id] === value) return;
    this.cache[id] = value;
    this.el[id].textContent = value;
  }
  setHtml(id, value) {
    if (this.cache['h' + id] === value) return;
    this.cache['h' + id] = value;
    this.el[id].innerHTML = value;
  }
  scale(id, v) {
    const q = Math.round(v * 200) / 200;
    if (this.cache['s' + id] === q) return;
    this.cache['s' + id] = q;
    this.el[id].style.transform = `scaleX(${q})`;
  }

  /* Guarded writes for everything that is not a cached element id.

     Every one of these used to run unconditionally, sixty times a second: a
     dozen classList.toggle calls on the combo ladder, a handful of
     style.setProperty on custom properties, and several querySelector lookups
     per frame. Each is a style invalidation, and on a Galaxy A30s the HUD as a
     whole was costing 8ms of JavaScript per frame before the compositor had
     even started. Writing only on change costs one comparison. */
  css(el, prop, value, key) {
    if (!el) return;
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    el.style.setProperty(prop, value);
  }
  cls(el, name, on, key) {
    if (!el) return;
    if (this.cache[key] === on) return;
    this.cache[key] = on;
    el.classList.toggle(name, on);
  }
  /** querySelector, resolved once and remembered. */
  qs(root, sel, key) {
    let e = this.cache['q' + key];
    if (e === undefined) { e = this.cache['q' + key] = root.querySelector(sel); }
    return e;
  }

  panel(name, on) {
    const el = $(name);
    if (el) el.classList.toggle('show', on);
  }
  hideAllPanels() {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('show'));
  }

  toast(msg, ms = 2200) {
    const t = this.el.toast;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('show'), ms);
  }

  boot(pct, text) {
    this.el.bootFill.style.width = Math.round(pct * 100) + '%';
    if (text) this.el.bootText.textContent = text;
  }
  bootDone() {
    this.el.boot.classList.add('gone');
    setTimeout(() => { this.el.boot.style.display = 'none'; }, 600);
  }

  banner(a, b) {
    const el = this.el.banner;
    el.querySelector('.b1').textContent = a;
    el.querySelector('.b2').textContent = b || '';
    this.bannerT = 2.1;
  }

  killFeed(text, kind) {
    const el = document.createElement('div');
    el.className = 'kf' + (kind ? ' ' + kind : '');
    el.innerHTML = text;
    this.el.killfeed.appendChild(el);
    this.feed.push({ el, t: 5.5 });
    while (this.feed.length > 5) {
      const old = this.feed.shift();
      old.el.remove();
    }
  }

  /* --------------------------------------------------------------- FRAME */

  /**
   * @param v.player   local player view
   * @param v.mode     mode descriptor
   * @param v.sim      simulation-ish state {wave, phase, intensity, teamScore, matchTime}
   * @param v.mates    other players
   * @param v.score    run score
   */
  update(dt, v) {
    const p = v.player;
    if (!p) return;

    const maxSh = v.maxShield ?? p.maxShield ?? T.player.shield;
    const hp = v.vehicle?.hp ?? p.hp, maxHp = v.vehicle?.maxHp || p.maxHp || 100;
    this.scale('hpFill', clamp(hp / maxHp, 0, 1));
    this.scale('shFill', !v.vehicle && maxSh > 0 ? clamp(p.shield / maxSh, 0, 1) : 0);
    this.setHtml('hpNum', `${v.vehicle ? '차량 내구도 ' : ''}<b>${Math.ceil(hp)}</b>/${Math.round(maxHp)}` +
      (!v.vehicle && p.shield > 0.5 ? ` <span style="color:var(--ice)">+${Math.ceil(p.shield)}</span>` : ''));
    this.set('score', (v.score || 0).toLocaleString());

    // combo ladder — only the rungs that actually changed state
    const rung = Math.min(T.combo.maxRung, p.combo || 0);
    if (this.cache.rung !== rung) {
      const was = this.cache.rung || 0;
      const lo = Math.min(was, rung), hi = Math.max(was, rung);
      for (let i = lo; i < hi; i++) this.rungs[i].classList.toggle('on', i < rung);
      this.cache.rung = rung;
    }
    this.css(this.el.ladder, 'opacity', p.combo > 0 ? '1' : '0', 'ladOp');
    this.setHtml('comboNum', `${p.combo || 0}<small>x</small>`);
    const decay = this.qs(this.el.comboDecay, 'i', 'decay') || this.el.comboDecay.firstElementChild;
    this.css(decay, 'transform',
      `scaleX(${Math.round(clamp((p.comboT || 0) / T.combo.window, 0, 1) * 100) / 100})`, 'decayT');

    // dash pips
    const maxC = T.dash.charges + (p.mods ? p.mods.dashExtra : 0);
    const pips = this.el.dashPips;
    while (pips.children.length < maxC) pips.appendChild(document.createElement('i'));
    while (pips.children.length > maxC) pips.lastChild.remove();
    if (this.cache.pips !== p.dashCharge || this.cache.pipsMax !== maxC) {
      this.cache.pips = p.dashCharge; this.cache.pipsMax = maxC;
      for (let i = 0; i < pips.children.length; i++) pips.children[i].classList.toggle('on', i < p.dashCharge);
    }
    // Quantised: a conic-gradient stop is a repaint, and nobody can see 1/100
    // of a turn on a 62px circle.
    const dashTurn = p.dashCharge >= maxC ? 0 : 1 - (p.dashTimer || 0) / T.dash.recharge;
    this.css(this.qs(this.el.dashPad, '.cd', 'dashCd'), '--p',
      (Math.round(dashTurn * 40) / 40) + 'turn', 'dashP');

    // abilities
    for (let i = 0; i < 2; i++) {
      const a = p.abilities ? p.abilities[i] : null;
      const el = this.el['ab' + (i + 1)];
      const icon = a ? a.def.icon : '—';
      const span = this.qs(el, 'span', 'abIcon' + i);
      if (span && this.cache['abI' + i] !== icon) { this.cache['abI' + i] = icon; span.textContent = icon; }
      this.cls(el, 'off', !a, 'abOff' + i);
      if (a) {
        this.css(this.qs(el, '.cd', 'abCd' + i), '--p',
          (Math.round((a.cd / a.def.cooldown) * 40) / 40) + 'turn', 'abP' + i);
      }
    }

    // wave / intensity
    if (v.mode.waves) {
      this.set('wave', 'WAVE ' + String(v.sim.wave || 0).padStart(2, '0'));
      this.set('waveName', v.modifier || '');
      this.el.topbar && (this.el.topbar.style.display = '');
    }
    // scaleX, not width: width is a layout property and this ran every frame.
    const inten = v.sim.intensity || 0;
    this.scale('intensityFill', clamp(inten, 0, 1));
    const col = inten > 0.7 ? 'var(--rose)' : inten > 0.4 ? 'var(--amber)' : 'var(--steel)';
    if (this.cache.intcol !== col) { this.cache.intcol = col; this.el.intensityFill.style.background = col; }

    // PvP scores and clock
    if (v.mode.pvp) {
      this.cls(this.el.teamScores, 'hidden', false, 'tsHid');
      this.cls(this.el.matchClock, 'hidden', false, 'mcHid');
      this.css(this.el.topbar || $('topbar'), 'display', 'none', 'tbDisp');
      this._teamScores(v.sim.teamScore || [], v.mode, p.team);
      const left = Math.max(0, (v.mode.timeLimit || 0) - (v.sim.matchTime || 0));
      this.set('matchClock', `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`);
    } else {
      this.el.teamScores.classList.add('hidden');
      this.el.matchClock.classList.add('hidden');
      $('topbar').style.display = '';
    }

    // squad list
    this._mates(v.mates || [], v.mode);

    // down / revive / respawn
    this.el.downNotice.classList.toggle('hidden', !p.down);
    this.el.reviveBar.classList.toggle('hidden', !(p.down && p.reviveT > 0.01));
    if (p.down && p.reviveT > 0.01) {
      this.el.reviveBar.querySelector('i').style.transform =
        `scaleX(${clamp(p.reviveT / (v.mode.reviveTime || 3), 0, 1)})`;
    }
    const respawning = !p.alive && v.mode.respawn;
    this.el.respawnNotice.classList.toggle('hidden', !respawning);
    if (respawning) this.el.respawnNotice.querySelector('b').textContent = Math.ceil(p.respawnT || 0);

    // banner
    if (this.bannerT > 0) {
      this.bannerT -= dt;
      const t = clamp(this.bannerT / 2.1, 0, 1);
      this.el.banner.style.opacity = String(t > 0.8 ? (1 - t) * 5 : Math.min(1, t * 2.2));
      this.el.banner.style.transform = `translateY(${(1 - Math.min(1, t * 3)) * -14}px)`;
    } else if (this.cache.bannerOff !== 1) {
      this.cache.bannerOff = 1;
      this.el.banner.style.opacity = '0';
    }
    if (this.bannerT > 0) this.cache.bannerOff = 0;

    // kill feed decay
    for (let i = this.feed.length - 1; i >= 0; i--) {
      const f = this.feed[i];
      f.t -= dt;
      if (f.t <= 0) { f.el.remove(); this.feed.splice(i, 1); }
      else if (f.t < 0.6) f.el.style.opacity = String(f.t / 0.6);
    }
  }

  _teamScores(scores, mode, myTeam) {
    const key = scores.join(',') + myTeam;
    if (this.cache.tsKey === key) return;
    this.cache.tsKey = key;
    let html = '';
    for (let i = 0; i < scores.length; i++) {
      html += `<div class="tscore t${i}${i === myTeam ? ' mine' : ''}">${scores[i]}<span class="tn">${TEAM_NAMES[i]}</span></div>`;
    }
    this.el.teamScores.innerHTML = html;
  }

  _mates(mates, mode) {
    const key = mates.map(m => `${m.id}:${Math.round(m.hp)}:${m.down ? 1 : 0}:${m.alive ? 1 : 0}`).join('|');
    if (this.cache.mateKey === key) return;
    this.cache.mateKey = key;
    let html = '';
    for (const m of mates) {
      const cls = !m.alive ? 'dead' : m.down ? 'down' : '';
      const colr = mode.pvp ? `var(--team${m.team})` : 'var(--ice)';
      html += `<div class="mate ${cls}"><span class="dot" style="background:${colr}"></span>` +
        `<span class="mn">${esc(m.name)}</span>` +
        `<span class="mbar"><i style="transform:scaleX(${clamp(m.hp / 100, 0, 1)})"></i></span></div>`;
    }
    this.el.squadList.innerHTML = html;
  }

  /* --------------------------------------------------- OFFSCREEN THREATS */

  /** Arrows at the screen edge for anything dangerous you cannot see. Capped
   *  at fourteen: past that it stops being information and becomes noise. */
  indicators(list, rig) {
    const W = window.innerWidth, H = window.innerHeight;
    const cx = W / 2, cy = H / 2;
    const margin = 46;
    let n = 0;
    for (const it of list) {
      if (n >= this.indicatorPool.length) break;
      const s = rig.project(it.x, 1.2, it.z, PROJ);
      let sx = s.x, sy = s.y;
      if (s.behind) { sx = W - sx; sy = H - sy; }
      if (!s.behind && sx > margin && sx < W - margin && sy > margin && sy < H - margin) continue;

      const a = Math.atan2(sy - cy, sx - cx);
      const rx = W / 2 - margin, ry = H / 2 - margin;
      const ex = cx + Math.cos(a) * rx, ey = cy + Math.sin(a) * ry;
      const slot = this.indicatorPool[n++];
      slot.el.className = 'ind' + (it.kind ? ' ' + it.kind : '');
      slot.el.style.transform = `translate(${ex | 0}px,${ey | 0}px) rotate(${a + Math.PI / 2}rad)`;
      slot.el.style.opacity = String(clamp(it.prox ?? 0.7, 0.2, 1));
    }
    for (let i = n; i < this.indicatorPool.length; i++) this.indicatorPool[i].el.style.opacity = '0';
  }

  /* -------------------------------------------------------------- MINIMAP */

  minimap(v) {
    const c = this.mm;
    const S = 132, R = S / 2 - 4;
    c.clearRect(0, 0, S, S);
    const scale = R / v.radius;

    c.save();
    c.translate(S / 2, S / 2);
    c.fillStyle = 'rgba(14,22,32,0.62)';
    c.beginPath(); c.arc(0, 0, R + 2, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(124,147,164,0.5)'; c.lineWidth = 1;
    c.beginPath(); c.arc(0, 0, R + 2, 0, Math.PI * 2); c.stroke();

    if (v.shrink && v.shrink < v.radius - 0.5) {
      c.strokeStyle = 'rgba(255,45,107,0.8)'; c.lineWidth = 1.5;
      c.beginPath(); c.arc(0, 0, v.shrink * scale, 0, Math.PI * 2); c.stroke();
    }

    c.fillStyle = 'rgba(124,147,164,0.32)';
    for (const p of v.props) {
      if (!p.alive) continue;
      c.fillRect(p.x * scale - 1.5, p.z * scale - 1.5, 3, 3);
    }

    for (const e of v.enemies) {
      c.fillStyle = e.elite ? '#FFB53D' : 'rgba(255,45,107,0.9)';
      const r = e.elite ? 2.6 : 1.6;
      c.beginPath(); c.arc(e.x * scale, e.z * scale, r, 0, Math.PI * 2); c.fill();
    }
    for (const m of v.mates) {
      c.fillStyle = v.pvp ? TEAM_HEX[m.team] : '#6FE3FF';
      c.beginPath(); c.arc(m.x * scale, m.z * scale, 2.4, 0, Math.PI * 2); c.fill();
    }

    // You: a wedge, so facing is legible at three pixels.
    const p = v.player;
    c.save();
    c.translate(p.x * scale, p.z * scale);
    c.rotate(p.aimA);
    c.fillStyle = '#FFB53D';
    c.beginPath(); c.moveTo(5, 0); c.lineTo(-3, 3); c.lineTo(-3, -3); c.closePath(); c.fill();
    c.restore();
    c.restore();
  }

  /* ------------------------------------------------------------ SETTINGS */

  buildSettings(settings, onChange) {
    const rows = [
      { k: 'aimAssist', label: 'AIM ASSIST', type: 'range', min: 0, max: 1.5, step: 0.05 },
      { k: 'haptics', label: 'HAPTICS', type: 'toggle' },
      { k: 'music', label: 'MUSIC', type: 'toggle' },
      { k: 'sfx', label: 'SOUND', type: 'toggle' },
      { k: 'minimap', label: 'MINIMAP', type: 'toggle' },
      { k: 'damageNumbers', label: 'DAMAGE NUMBERS', type: 'toggle' },
      { k: 'reducedMotion', label: 'REDUCED MOTION', type: 'toggle' },
      { k: 'showFps', label: 'SHOW FPS', type: 'toggle' }
    ];
    const host = this.el.settingsList;
    host.innerHTML = '';
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'row';
      const lab = document.createElement('span');
      lab.textContent = r.label;
      row.appendChild(lab);

      if (r.type === 'range') {
        const inp = document.createElement('input');
        inp.type = 'range';
        inp.min = r.min; inp.max = r.max; inp.step = r.step;
        inp.value = settings[r.k];
        inp.oninput = () => { settings[r.k] = +inp.value; onChange(r.k); };
        row.appendChild(inp);
      } else {
        const b = document.createElement('div');
        const paint = () => {
          b.className = 'tog' + (settings[r.k] ? ' on' : '');
          b.textContent = settings[r.k] ? 'ON' : 'OFF';
        };
        paint();
        b.onclick = () => { settings[r.k] = !settings[r.k]; paint(); onChange(r.k); };
        row.appendChild(b);
      }
      host.appendChild(row);
    }
  }

  /* -------------------------------------------------------------- CARDS */

  showUpgrades(cards, onPick, rerolls, onReroll) {
    const host = this.el.cards;
    host.innerHTML = '';
    for (const u of cards) {
      const card = document.createElement('div');
      card.className = 'card ' + (u.type === 'act' ? 'act' : 'pas');
      card.innerHTML =
        `<div class="tp">${u.type === 'act' ? 'ACTIVE' : 'PASSIVE'}</div>` +
        `<div class="ic">${u.icon}</div><div class="nm">${esc(u.name)}</div>` +
        `<div class="ds">${esc(u.desc)}</div>` +
        `<div class="tp">${u.owned > 0 ? 'OWNED ' + u.owned : ''}</div>`;
      card.onclick = () => onPick(u);
      host.appendChild(card);
    }
    this.el.reroll.textContent = 'REROLL (' + rerolls + ')';
    this.el.reroll.style.display = rerolls > 0 ? 'inline-block' : 'none';
    this.el.reroll.onclick = onReroll;
    this.panel('upgradeScreen', true);
  }

  /* --------------------------------------------------------- SCOREBOARD */

  showResults(o) {
    this.set('resultTitle', o.title);
    this.set('deathLine', o.line);
    this.el.summary.innerHTML = o.stats
      .map(([k, v]) => `<div><div class="v num">${v}</div><div class="k">${k}</div></div>`)
      .join('');

    if (o.players && o.players.length > 1) {
      let html = '<div class="sbrow head"><span class="tdot"></span><span class="nm">PLAYER</span>' +
        '<span class="c">K</span><span class="c">D</span><span class="c">SCORE</span></div>';
      for (const p of o.players) {
        html += `<div class="sbrow${p.me ? ' me' : ''}">` +
          `<span class="tdot" style="background:${o.pvp ? TEAM_HEX[p.team] : '#6FE3FF'}"></span>` +
          `<span class="nm">${esc(p.name)}${p.bot ? ' <span class="botTag">BOT</span>' : ''}</span>` +
          `<span class="c">${p.kills}</span><span class="c">${p.deaths}</span>` +
          `<span class="c">${p.score.toLocaleString()}</span></div>`;
      }
      this.el.scoreboard.innerHTML = html;
    } else this.el.scoreboard.innerHTML = '';

    if (o.xp) {
      this.el.xpBar.classList.remove('hidden');
      this.el.xpLevel.textContent = 'LV ' + o.xp.level;
      this.el.xpGain.textContent = '+' + o.xp.gained + ' XP';
      this.el.xpFill.style.transform = 'scaleX(0)';
      requestAnimationFrame(() => {
        this.el.xpFill.style.transform = `scaleX(${clamp(o.xp.progress, 0, 1)})`;
      });
    } else this.el.xpBar.classList.add('hidden');

    this.panel('deathScreen', true);
  }

  /* -------------------------------------------------------------- LOBBY */

  lobby(state) {
    this.set('lobbyMode', state.modeName);
    this.set('roomCode', state.code || '------');
    let html = '';
    for (let i = 0; i < state.maxPlayers; i++) {
      const p = state.players[i];
      if (!p) { html += '<div class="lp empty"><div class="lpn">—</div><div class="lps">참가 대기</div></div>'; continue; }
      html += `<div class="lp t${p.team ?? 0}${p.ready ? ' ready' : ''}">` +
        `<div class="lpn">${esc(p.name)}${p.bot ? ' ·BOT' : ''}</div>` +
        `<div class="lps">${p.ready ? '준비 완료' : '준비 중'}</div></div>`;
    }
    this.el.lobbyPlayers.innerHTML = html;
    this.set('lobbyStatus', state.status);
    this.el.readyBtn.textContent = state.youReady ? '준비 취소' : '준비 완료';
  }

  net(ping, state) {
    if (state === 'off') { this.el.netbadge.classList.add('hidden'); return; }
    this.el.netbadge.classList.remove('hidden');
    this.el.netbadge.className = ping > 220 ? 'bad' : ping > 120 ? 'warn' : '';
    this.set('pingText', ping >= 0 ? ping + 'ms' : '--');
  }
}

const TEAM_HEX = ['#4FC3F7', '#FF7043', '#AED581', '#BA68C8'];
const PROJ = { x: 0, y: 0, behind: false };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
