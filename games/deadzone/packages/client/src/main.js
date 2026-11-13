// Modified for Z-RIDE DEADZONE: cooperative web app and dashboard handoff.
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

/* ================================= APP ==================================

   The orchestrator. It owns the loop, the state machine, and the translation
   layer between the simulation's events and everything the player actually
   perceives — sound, 2D effects, haptics, HUD.

   The loop is a fixed-timestep accumulator with interpolated rendering, and
   it runs the same way offline and online. The only difference is where the
   authoritative state comes from:

     offline   the local Sim is the truth
     online    the server is the truth, the local Sim predicts your player,
               and everything else is interpolated between snapshots

   Hitstop freezes the simulation without freezing the frame — which is why a
   shotgun hit feels heavy — but only offline. Online it becomes a purely
   visual pulse, because you cannot stop time for eight people.              */

import QRCode from 'qrcode';
import { dashboardSnapshot, difficultyFor } from '@overrun/shared/zride.js';
import { allowsSeatAim, relativeSeatAim, seatSectors } from '@overrun/shared/seat-aim.js';
import { VEHICLE_SEATS, vehiclePoint, vehiclePose, windowMuzzle } from '@overrun/shared/vehicle.js';
import { Sim } from '@overrun/shared/sim.js';
import { T, TEAM_NAMES } from '@overrun/shared/constants.js';
import { EV } from '@overrun/shared/events.js';
import { ENEMY_TYPES } from '@overrun/shared/defs.js';
import { MODES, getMode } from '@overrun/shared/modes.js';
import { ABILITIES } from '@overrun/shared/abilities.js';
import { UPGRADES, offerUpgrades } from '@overrun/shared/upgrades.js';
import { clamp, lerp, damp, dist2 } from '@overrun/shared/math.js';
import { makeRng } from '@overrun/shared/rng.js';

import { Topdown } from './render/topdown.js';
import { AudioEngine } from './audio/audio.js';
import { Input, haptic, HAPTIC, setHaptics } from './input/input.js';
import { UI } from './ui/ui.js';
import { NetClient } from './net/client.js';

/* ------------------------------------------------------------- SETTINGS */

const Save = {
  key: 'zride.deadzone.v1',
  data: { best: 0, bestWave: 0, runs: 0, kills: 0, xp: 0, level: 1, name: '', settings: {} },
  load() {
    try { Object.assign(this.data, JSON.parse(localStorage.getItem(this.key) || '{}')); } catch (e) { void e; }
    return this.data;
  },
  flush() { try { localStorage.setItem(this.key, JSON.stringify(this.data)); } catch (e) { void e; } }
};
Save.load();

const Settings = Object.assign({
  aimAssist: 1, haptics: true, music: true, sfx: true,
  minimap: true, damageNumbers: true, showFps: false,
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches
}, Save.data.settings || {});

function saveSettings() { Save.data.settings = Settings; Save.flush(); }

/* ---------------------------------------------------------------- APP */

class App {
  constructor() {
    this.practiceChannel = new BroadcastChannel('zride.practice.v1');
    this.lastDashboardFrame = 0;
    this.state = 'boot';
    this.mode = MODES.coop;
    this.online = false;
    this.time = 0;
    this.frame = 0;
    this.accumulator = 0;
    this.hitstop = 0;
    this.slowmo = 1;
    this.slowmoT = 0;
    this.damageFlash = 0;
    this.lowHealth = 0;
    this.run = { score: 0, rerolls: 1, time: 0, bestCombo: 0 };
    this.pendingChoice = null;
    this.lastFrameMs = 16;
  }

  /* ----------------------------------------------------------- BOOT */

  async boot() {
    this.ui = new UI(this);
    this.ui.boot(0.05, 'STARTING ENGINE');

    const canvas = document.getElementById('gl');
    this.stage = new Topdown(canvas, Settings);

    await frame();
    this.ui.boot(0.25, 'POURING CONCRETE');

    // The local Sim always exists: it is the offline game, the prediction
    // engine online, and the source of world geometry in both.
    this.sim = new Sim({ seed: 20260731, mode: 'coop' });
    this.input = new Input(canvas, Settings);
    this.input.onPause = () => this.togglePause();
    setHaptics(Settings.haptics);

    this.audio = new AudioEngine(Settings);
    this.net = null;

    this.bindUI();
    this.buildModeGrid();
    this.buildHowTo();
    this.ui.buildSettings(Settings, (k) => this.onSettingChange(k));
    this.refreshProfileStrip();

    document.getElementById('titleHint').innerHTML = matchMedia('(pointer: coarse)').matches
      ? '차량 방은 적을 눌러 사격 · 자유 이동은 왼손 이동, 오른손 조준'
      : '차량 방은 적을 클릭해 사격 · 자유 이동은 WASD, 마우스 조준, SPACE 대시';

    this.ui.el.best.textContent = 'BEST ' + Save.data.best;

    await frame();
    this.present(0, 0);

    this.ui.boot(1, 'READY');
    await sleep(180);
    this.ui.bootDone();

    /* Only claim the title screen if nothing has happened yet.

       The menu is built and clickable well before this line — the mode grid
       exists as soon as the UI is wired, and there is an unconditional 180ms
       sleep immediately above. Someone who taps SOLO inside that window gets
       a match that is fully constructed by beginMatch() and then silently
       demoted back to 'title' here, so the loop below starts and steps
       nothing. The button appears dead and a second tap fixes it, which is
       the worst possible shape for a bug: intermittent, fast-machine-only,
       and invisible to anyone who clicks slowly. */
    if (this.state === 'boot') this.state = 'title';

    this.checkOrientation();
    addEventListener('resize', () => { this.stage.resize(); this.checkOrientation(); });
    addEventListener('orientationchange', () => setTimeout(() => this.checkOrientation(), 140));
    document.addEventListener('visibilitychange', () => this.onVisibility());

    // Deep link: /j/ABC123 drops straight into a friend's room.
    const path = location.pathname.match(/\/j\/([A-Za-z0-9]{4,8})/);
    const q = new URLSearchParams(location.search);
    const code = (path && path[1]) || q.get('room');
    if (code) setTimeout(() => this.joinRoom(code.toUpperCase()), 400);

    this.loop = this.loop.bind(this);
    this.lastNow = performance.now();
    requestAnimationFrame(this.loop);
  }

  buildModeGrid() {
    this.selectedPlayers = 1;
    const host = document.getElementById('modeGrid');
    host.innerHTML = `
      <div class="mission-kicker"><span class="live-dot"></span> PARKING LOT · CO-OP SURVIVAL</div>
      <h2>함께 버티는<br><em>마지막 주차장.</em></h2>
      <p class="mission-copy">좀비의 포위를 뚫고 보급품을 모으세요.<br>폰을 연결하면, 우리 차가 팀의 작전실이 됩니다.</p>
      <label class="field-label" for="survivorName">생존자 이름</label>
      <input id="survivorName" maxlength="18" placeholder="생존자" autocomplete="nickname">
      <div class="field-head"><span>함께할 인원</span><small>1–4 PLAYERS</small></div>
      <div class="party-picker" role="group" aria-label="참가 인원">
      ${[1,2,3,4].map(n=>`<button type="button" data-players="${n}" aria-pressed="${n===1}"><b>${n}</b><span>명</span></button>`).join('')}</div>
      <div class="difficulty-note"><span id="difficultyLabel">생존자</span><b id="difficultyValue">좀비 출현량 ×1.00</b></div>
      <button class="z-primary" id="zCreate">협동 방 만들기 <span>↗</span></button>
      <button class="z-secondary" id="zPractice">혼자 체험하기</button>
      <p id="practiceNote" class="fineprint">선택한 인원에 맞게 AI 동료를 채워 체험합니다.</p>
      <a class="dashboard-entry" href="/infected.html" target="_blank" rel="noopener">감염체 도감 <span>↗</span></a>
      <a class="dashboard-entry" href="/dashboard" target="_blank" rel="noopener">차량 대시보드 열기 <span>↗</span></a>`;
    const name = document.getElementById('survivorName'); name.value = Save.data.name || '';
    const saveName = () => { Save.data.name = name.value.trim().slice(0,18) || '생존자'; Save.flush(); };
    host.querySelectorAll('[data-players]').forEach(button => button.onclick = () => {
      this.selectedPlayers = Number(button.dataset.players);
      host.querySelectorAll('[data-players]').forEach(b => b.setAttribute('aria-pressed',String(b===button)));
      const d=difficultyFor(this.selectedPlayers);
      document.getElementById('difficultyLabel').textContent=d.label;
      document.getElementById('difficultyValue').textContent='좀비 출현량 ×'+d.spawnMultiplier.toFixed(2);
      document.getElementById('zPractice').textContent=this.selectedPlayers===1?'혼자 체험하기':`AI 동료 ${this.selectedPlayers-1}명과 체험하기`;
    });
    document.getElementById('zCreate').onclick=()=>{saveName();this.createRoom('coop');};
    document.getElementById('zPractice').onclick=()=>{saveName();this.startLocal('coop');};
  }

  buildHowTo() {
    const touch = matchMedia('(pointer: coarse)').matches;
    document.getElementById('howBody').innerHTML = `
      <h4>THE ONLY RULE</h4>
      <p>Standing still is how you die. Everything in this game is designed around movement — your dash has invulnerability frames, your shield only regenerates when you disengage, and the arena rebuilds its cover between every wave.</p>
      <h4>CONTROLS</h4>
      <p>차량 방에서는 색으로 표시된 좌석의 담당 방향에서 적을 눌러 사격합니다. 누르고 있으면 연사합니다.</p>
      <p>${touch
        ? '<b>Left thumb</b> anywhere on the left half moves. <b>Right thumb</b> aims and fires — or let go and the gun engages whatever you are already facing. <b>DASH</b> is bottom right.'
        : '<b>WASD</b> moves, <b>mouse</b> aims, <b>hold left click</b> to fire. <b>Space</b> dashes, <b>E</b> and <b>F</b> cast abilities, <b>Q</b> swaps weapon, <b>1–6</b> selects directly. A gamepad works too.'}</p>
      <h4>THE COMBO LADDER</h4>
      <p>Every kill ratchets it up and raises your fire rate. Getting hit costs you most of it. It decays in ${T.combo.window} seconds, so it is a reason to keep pushing rather than a reason to be careful.</p>
      <h4>TELEGRAPHS</h4>
      <p>Every enemy attack warns you for at least a quarter of a second, in colour and in sound. If it is rose, it can kill you. Nothing decorative is ever rose.</p>
      <h4>ONLINE</h4>
      <p><b>Online</b> finds you a match. <b>Room</b> gives you a six-character code — send it to a friend and they join instantly, no account needed.</p>`;
  }

  refreshProfileStrip() {
    const d = Save.data;
    document.getElementById('profileStrip').innerHTML =
      `<b>LV ${d.level}</b> · ${d.runs} RUNS · ${d.kills.toLocaleString()} KILLS · BEST ${d.best.toLocaleString()}`;
  }

  bindUI() {
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };

    on('settingsBtn', () => { this.ui.hideAllPanels(); this.ui.panel('pauseScreen', true); this.state = 'settings'; document.getElementById('pauseTitle').textContent = 'SETTINGS'; });
    on('howBtn', () => { this.ui.hideAllPanels(); this.ui.panel('howScreen', true); this.state = 'howto'; });
    on('howBackBtn', () => this.toTitle());
    on('joinCodeBtn', () => { this.ui.hideAllPanels(); this.ui.panel('joinScreen', true); this.state = 'join'; setTimeout(() => this.ui.el.codeInput.focus(), 60); });
    on('joinBackBtn', () => this.toTitle());
    on('joinGoBtn', () => this.joinRoom(this.ui.el.codeInput.value.trim().toUpperCase()));
    on('resumeBtn', () => { if (this.state === 'settings') this.toTitle(); else this.togglePause(); });
    on('quitBtn', () => this.endRun('quit'));
    on('pauseBtn', () => this.togglePause());
    on('retryBtn', () => this.replay());
    on('menuBtn', () => this.toTitle());
    on('leaveLobbyBtn', () => { if (this.net) this.net.close(); this.toTitle(); });
    on('readyBtn', () => { this._ready = !this._ready; if (this.net) this.net.sendReady(this._ready); });
    on('copyCodeBtn', () => this.copyInvite());
    on('shareBtn', () => this.shareInvite());

    this.ui.el.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.joinRoom(this.ui.el.codeInput.value.trim().toUpperCase());
    });
    this.input.bindButton(document.getElementById('dashPad'), () => { this.input.pendingDash = true; haptic(HAPTIC.ui); });
    this.input.bindButton(document.getElementById('ab1'), () => { this.input.pendingAb[0] = true; });
    this.input.bindButton(document.getElementById('ab2'), () => { this.input.pendingAb[1] = true; });
    this.input.bindButton(document.getElementById('weapon'), () => { this.input.pendingWeaponCycle = true; });
  }

  onSettingChange(k) {
    saveSettings();
    if (k === 'haptics') setHaptics(Settings.haptics);
    if (k === 'minimap') document.getElementById('minimap').classList.toggle('hidden', !Settings.minimap);
    this.audio.ui('tick');
  }

  /* --------------------------------------------------------- FLOW / STATE */

  toTitle() {
    this.partySeat = null;
    this.mounted = false;
    this.input.setMounted(false);
    this.me = null;
    this.serverState = null;
    this.stage.reset();
    document.body.classList.remove('mounted-combat');
    document.getElementById('seatAim').hidden = true;
    this.ui.hideAllPanels();
    this.ui.panel('titleScreen', true);
    this.ui.el.hud.classList.add('hidden');
    this.state = 'title';
    this.checkOrientation();
    this.online = false;
    this.audio.musicOn = false;
    if (this.net) { this.net.close(); this.net = null; }
    this.ui.net(-1, 'off');
    this.refreshProfileStrip();
  }

  async ensureAudio() {
    if (!this.audio.ready) {
      await this.audio.init();
    }
    this.audio.resume();
  }

  async startLocal(modeId) {
    await this.ensureAudio();
    this.online = false;
    this.mode = getMode(modeId);
    this.sim = new Sim({ seed: (Math.random() * 0xffffffff) >>> 0, mode: modeId, partySize: this.selectedPlayers || 1 });

    this.localId = 1;
    const me = this.sim.addPlayer(1, { name: Save.data.name || 'YOU', team: 0 });
    this.me = me;

    if (!this.mode.pvp) {
      for(let i=1;i<(this.selectedPlayers || 1);i++)
        this.sim.addPlayer(100+i,{name:'AI 동료 '+i,team:0,bot:true});
    }
    // Solo PvP fills the arena with bots so the mode is playable alone.
    if (this.mode.pvp) {
      const n = this.mode.maxPlayers - 1;
      for (let i = 0; i < n; i++) {
        this.sim.addPlayer(100 + i, { name: BOT_NAMES[i % BOT_NAMES.length], bot: true });
      }
      this.sim.rebalanceTeams();
      this.me.team = 0;
    }

    this.beginMatch();
    document.getElementById('hudDashboard').href='/dashboard?practice=1';
    if(parent!==window)parent.postMessage({type:'zride:practice'},location.origin);
  }

  beginMatch() {
    this.ui.hideAllPanels();
    this.ui.el.hud.classList.remove('hidden');
    document.getElementById('minimap').classList.toggle('hidden', !Settings.minimap);
    this.run = { score: 0, rerolls: 1, time: 0, bestCombo: 0 };
    this.state = 'play';
    this.accumulator = 0;
    this.audio.musicOn = true;
    this.audio.setLowHealth(false);
    this.stage.reset();
    this.input.clearPointers();
    this.damageFlash = 0;
    if (this.sim.mode.waves) this.sim.director.startWave();
    Save.data.runs++;
    Save.flush();
    this.checkOrientation();
    if (!this.mounted) lockOrientation();
    requestWakeLock();
  }

  replay() {
    if (this.online && this.net) { this.net.sendReady(true); this.ui.hideAllPanels(); return; }
    this.startLocal(this.mode.id);
  }

  togglePause() {
    if (this.state === 'play') {
      if (this.online) { this.ui.toast('CANNOT PAUSE ONLINE'); return; }
      this.state = 'pause';
      document.getElementById('pauseTitle').textContent = 'PAUSED';
      this.ui.panel('pauseScreen', true);
      this.audio.suspend();
    } else if (this.state === 'pause') {
      this.ui.panel('pauseScreen', false);
      this.state = 'play';
      this.audio.resume();
    }
  }

  endRun(reason) {
    if (this.state === 'dead') return;
    this.ui.panel('pauseScreen', false);
    this.state = 'dead';
    this.audio.musicOn = false;
    this.audio.setLowHealth(false);
    this.stage.reset();
    this.input.clearPointers();

    const best = Math.max(Save.data.best, this.run.score);
    Save.data.best = best;
    Save.data.bestWave = Math.max(Save.data.bestWave, this.sim.director.wave);
    Save.data.kills += this.me ? this.me.kills : 0;

    // Local XP so solo play still has a progression curve when offline.
    const gained = Math.round((this.me ? this.me.kills : 0) * T.progression.xpPerKill
      + this.sim.director.wave * T.progression.xpPerWave + T.progression.xpPerMatch);
    Save.data.xp += gained;
    Save.data.level = levelFromXp(Save.data.xp);
    Save.flush();

    const acc = this.me && this.me.shotsFired
      ? Math.min(100, Math.round((this.me.shotsHit / this.me.shotsFired) * 100)) : 0;
    const mins = Math.floor(this.run.time / 60), secs = Math.floor(this.run.time % 60);

    const players = this.sim.players.map(p => ({
      name: p.name, kills: p.kills, deaths: p.deaths, score: p.score,
      team: p.team, bot: p.bot, me: p === this.me
    })).sort((a, b) => b.score - a.score);

    setTimeout(() => {
      this.ui.showResults({
        title: this.mode.pvp ? (this.matchWinner === this.me.team ? 'VICTORY' : 'DEFEAT') : 'DEADZONE',
        line: reason === 'quit' ? 'RUN ENDED'
          : this.run.score > best - gained ? 'NEW BEST — THE ARENA REMEMBERS'
            : 'THE ARENA KEEPS THE SCORE',
        stats: [
          ['SCORE', this.run.score.toLocaleString()],
          [this.mode.waves ? 'WAVE' : 'KILLS', this.mode.waves ? this.sim.director.wave : (this.me ? this.me.kills : 0)],
          ['KILLS', this.me ? this.me.kills : 0],
          ['BEST COMBO', this.run.bestCombo + 'x'],
          ['TIME', mins + ':' + String(secs).padStart(2, '0')],
          ['ACCURACY', acc + '%']
        ],
        players: players.length > 1 ? players : null,
        pvp: this.mode.pvp,
        xp: { level: Save.data.level, gained, progress: xpProgress(Save.data.xp) }
      });
      this.ui.el.best.textContent = 'BEST ' + Save.data.best;
    }, 620);
  }

  /* ------------------------------------------------------------- ONLINE */

  async quickplay(modeId) {
    await this.ensureAudio();
    this.ui.toast('FINDING A MATCH…', 4000);
    try {
      const r = await fetch('/api/quickplay', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: modeId })
      });
      if (!r.ok) throw new Error('no server');
      const { code } = await r.json();
      this.joinRoom(code, modeId);
    } catch (e) {
      void e;
      this.ui.toast('NO SERVER — PLAYING OFFLINE');
      this.startLocal(modeId);
    }
  }

  async createRoom(modeId) {
    await this.ensureAudio();
    const button=document.getElementById('zCreate');button.disabled=true;button.textContent='방을 준비하고 있어요…';
    try {
      const r=await fetch('/api/zride/rooms',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({players:this.selectedPlayers || 1,hostName:Save.data.name})});
      if(!r.ok)throw new Error('방 생성에 실패했습니다.');
      const room=await r.json();
      this.dashboardPath=room.dashboardPath;
      if(parent!==window) parent.postMessage({type:'zride:room',code:room.code,dashboardPath:room.dashboardPath},location.origin);
      document.getElementById('hudDashboard').href=room.dashboardPath;
      this.joinRoom(room.code,modeId);
    } catch(e) { this.ui.toast('서버 연결을 확인한 뒤 다시 시도해 주세요.'); }
    finally { button.disabled=false;button.innerHTML='협동 방 만들기 <span>↗</span>'; }
  }

  joinRoom(code, modeHint) {
    if (!code || code.length < 4) { this.ui.set('joinError', 'ENTER A VALID CODE'); return; }
    this.ensureAudio();
    if (this.net) { this.net.close(); this.net = null; }
    this.roomCode = code;
    const dash=document.getElementById('lobbyDashboard');
    dash.hidden=!this.dashboardPath; if(this.dashboardPath)dash.href=this.dashboardPath;
    const fragment = new URLSearchParams(location.hash.slice(1));
    const ticketKey = 'deadzone.party-ticket:' + location.pathname;
    const partyTicket = fragment.get('party') || sessionStorage.getItem(ticketKey);
    document.querySelector('.lobby-invite').hidden = Boolean(partyTicket);
    document.getElementById('roomCodeWrap').hidden = Boolean(partyTicket);
    document.getElementById('lobbyScreen').classList.toggle('party-lobby', Boolean(partyTicket));
    const invite=location.origin+'/j/'+code;
    if (!partyTicket) QRCode.toCanvas(document.getElementById('lobbyQr'),invite,{width:136,margin:2,color:{dark:'#0b1515',light:'#ffffff'}}).catch(()=>{});
    document.getElementById('inviteAddress').textContent=invite;
    document.getElementById('lobbyNetworkNote').textContent=['localhost','127.0.0.1'].includes(location.hostname)?'폰 참가 시 같은 Wi-Fi에서 Mac의 LAN 주소로 열어 QR을 생성하세요.':'';
    this.online = true;
    this._ready = false;
    this.ui.hideAllPanels();
    this.ui.panel('lobbyScreen', true);
    this.state = 'lobby';
    this.ui.lobby({
      code, modeName: (MODES[modeHint] || MODES.coop).name,
      players: [], maxPlayers: 8, status: 'CONNECTING…', youReady: false
    });

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws?code=${encodeURIComponent(code)}&name=${encodeURIComponent(Save.data.name || 'RUNNER')}`;

    this.net = new NetClient({
      onWelcome: (w) => this.onWelcome(w),
      onSnapshot: (s) => this.onSnapshot(s),
      onEvents: (l) => this.presentEvents(l),
      onLobby: (l) => this.onLobby(l),
      onChoice: (c) => this.onChoice(c),
      onEnd: (e) => this.onMatchEnd(e),
      onKick: (k) => { this.toTitle(); this.ui.toast(k.reason==='full'?'팀 정원이 찼습니다. 다른 팀 코드를 확인해 주세요.':k.reason==='match_in_progress'?'진행 중인 경기입니다. 다음 경기에서 참가해 주세요.':'연결이 종료되었습니다. 다시 참가해 주세요.'); },
      onClose: () => { if (this.state !== 'title') this.ui.net(-1, 'off'); }
    });
    if (fragment.has('party') && partyTicket) {
      sessionStorage.setItem(ticketKey, partyTicket);
      history.replaceState(null, '', location.pathname + location.search);
    }
    this.net.connect(url, { name: Save.data.name || '생존자', skin: 0, partyTicket });
  }

  onWelcome(w) {
    this.serverState = null;
    this.partySeat = Object.hasOwn(seatSectors, w.partySeat) ? w.partySeat : null;
    this.mounted = !!this.partySeat && w.sharedVehicle === true;
    this.riderSeats = new Map();
    this.updateRiderSeats(w.players);
    if (this.partySeat) this.riderSeats.set(w.playerId, { seat: this.partySeat, name: w.you?.name });
    document.body.classList.toggle('mounted-combat', this.mounted);
    this.input.setMounted(this.mounted);
    const seatAim = document.getElementById('seatAim');
    seatAim.hidden = true;
    if (this.partySeat) {
      const labels = { FRONT_PASSENGER: '조수석 · 전방 180°', REAR_LEFT: '뒤 왼쪽 · 후방 90°', REAR_RIGHT: '뒤 오른쪽 · 후방 90°' };
      document.getElementById('seatAimTitle').textContent = labels[this.partySeat];
      seatAim.style.setProperty('--seat-color', '#' + VEHICLE_SEATS[this.partySeat].color.toString(16));
    }
    this.localId = w.playerId;
    this.mode = getMode(w.mode);
    // Rebuild the world from the server's seed. Because layout is a pure
    // function of the seed, this costs one message and zero geometry.
    this.sim = new Sim({ seed: w.seed, mode: w.mode, partySize: w.targetPlayers, authoritative: false });
    this.me = this.sim.addPlayer(w.playerId, { name: w.you && w.you.name, team: (w.you && w.you.team) || 0 });
    for (const p of w.players || []) {
      if (p.id !== w.playerId) this.sim.addPlayer(p.id, { name: p.name, team: p.team, bot: p.bot });
    }
    if (w.state === 'playing') this.beginMatch();
    this.ui.toast('팀에 연결되었습니다.');
  }

  onLobby(l) {
    this.updateRiderSeats(l.players);
    if (l.reason === 'start') {
      if (l.seed && l.seed !== this.sim.seed) {
        this.sim = new Sim({ seed: l.seed, mode: this.mode.id, authoritative: false });
        this.me = this.sim.addPlayer(this.localId, { name: Save.data.name || 'YOU' });
      }
      this.beginMatch();
      return;
    }
    this.ui.lobby({
      code: this.roomCode,
      modeName: this.mode.name,
      players: l.players || [],
      maxPlayers: l.maxPlayers || this.mode.maxPlayers,
      status: l.state === 'countdown' ? `${l.countdown}초 후 시작` : `${(l.players||[]).length} / ${l.targetPlayers || l.maxPlayers}명 참가 · 모두 준비하면 시작합니다`,
      youReady: this._ready
    });
  }

  updateRiderSeats(players = []) {
    if (!this.partySeat) return;
    for (const player of players) {
      if (Object.hasOwn(VEHICLE_SEATS, player.partySeat)) {
        this.riderSeats.set(player.id, { seat: player.partySeat, name: player.name });
      }
    }
  }

  onSnapshot(s) {
    // Reconcile our own player against authority.
    const mine = s.players.find(p => p.id === this.localId);
    if (mine && this.me) {
      const pending = this.net.ackInputs(mine.seq);
      const err = Math.hypot(this.me.x - mine.x, this.me.z - mine.z);
      if (this.mounted || err > T.net.reconcileSnap) {
        // Big divergence: something happened we did not predict (a knockback,
        // a teleport, a hit we did not see). Accept the server's word.
        this.me.x = mine.x; this.me.z = mine.z;
        this.me.vx = mine.vx; this.me.vz = mine.vz;
        // The server's position already contains whatever impulse produced
        // this divergence. Keeping our own would apply it a second time.
        this.me.ivx = 0; this.me.ivz = 0;
      } else if (err > 0.02) {
        // Small divergence: replay unacknowledged inputs from the server's
        // position and ease into the result, so a correction never snaps.
        const sx = this.me.x, sz = this.me.z;
        this.me.x = mine.x; this.me.z = mine.z;
        this.me.vx = mine.vx; this.me.vz = mine.vz;
        for (const rec of pending) {
          this.sim.setInput(this.localId, { ...rec.input, seq: undefined });
          this.sim.stepPlayer(this.me, rec.dt);
        }
        this.me.x = lerp(this.me.x, sx, 0.35);
        this.me.z = lerp(this.me.z, sz, 0.35);
      }
      this.me.hp = mine.hp;
      this.me.shield = mine.sh;
      this.me.alive = mine.alive;
      this.me.down = mine.down;
      this.me.reviveT = mine.rev;
      this.me.dashCharge = mine.dash;
      this.me.combo = mine.combo;
      this.me.kills = mine.k;
      this.me.deaths = mine.d;
      this.me.score = mine.sc;
      this.me.team = mine.team;
      this.run.score = mine.sc;
    }
    if (s.wave !== this.serverState?.wave && s.wave > 0) this.sim.world.layout(s.wave, !this.serverState);
    if (s.phase === 'choice' && this.serverState?.phase !== 'choice') this.sim.world.sink();
    this.serverState = s;
  }

  onChoice(c) {
    this.pendingChoice = c;
    this.state = 'choice';
    this.ui.showUpgrades(c.cards, (u) => {
      this.net.sendPick({ id: u.id, kind: u.kind, slot: u.slot });
      this.ui.panel('upgradeScreen', false);
      this.state = 'play';
      this.audio.ui('ok');
    }, 0, null);
  }

  onMatchEnd(e) {
    this.matchWinner = e.over ? e.over.winner : null;
    this.state = 'dead';
    const players = (e.results || []).map(p => ({ ...p, me: p.id === this.localId }))
      .sort((a, b) => b.score - a.score);
    this.ui.showResults({
      title: this.mode.pvp ? (this.matchWinner === (this.me ? this.me.team : -1) ? 'VICTORY' : 'DEFEAT') : 'DEADZONE',
      line: e.over ? endReason(e.over) : '',
      stats: [
        ['SCORE', (this.me ? this.me.score : 0).toLocaleString()],
        ['KILLS', this.me ? this.me.kills : 0],
        ['DEATHS', this.me ? this.me.deaths : 0],
        ['WAVE', e.wave || 0]
      ],
      players, pvp: this.mode.pvp, xp: null
    });
  }

  copyInvite() {
    const url = `${location.origin}/j/${this.roomCode}`;
    if (!navigator.clipboard) { this.ui.toast(url,6000); return; }
    navigator.clipboard.writeText(url)
      .then(() => this.ui.toast('LINK COPIED'))
      .catch(() => this.ui.toast(url));
  }
  shareInvite() {
    const url = `${location.origin}/j/${this.roomCode}`;
    if (navigator.share) navigator.share({ title: 'DEADZONE', text: `Join my match — code ${this.roomCode}`, url }).catch(() => {});
    else this.copyInvite();
  }

  /* ------------------------------------------------------------ THE LOOP */

  loop(now) {
    requestAnimationFrame(this.loop);
    const t0 = performance.now();
    let raw = (now - this.lastNow) / 1000;
    this.lastNow = now;
    if (!(raw > 0)) raw = 0.016;

    /* The true interval between presented frames, before the simulation's
       safety clamp. This is what the player experiences, and it is the only
       honest input to adaptive quality. Keeping it separate matters because
       `raw` gets clamped to maxFrameDt on the very next line — feed that to
       the sampler and a 400ms stall reports as 100ms. */
    this.frameIntervalMs = raw * 1000;

    raw = Math.min(raw, T.sim.maxFrameDt);
    this.time += raw;
    this.frame++;

    // Timing modifiers
    this.slowmoT = Math.max(0, this.slowmoT - raw);
    const wantSlow = this.slowmoT > 0 && !this.online ? T.feel.slowmoScale : 1;
    this.slowmo = damp(this.slowmo, wantSlow, 12, raw);
    this.damageFlash = Math.max(0, this.damageFlash - raw * 1.6);

    const tSim = DEBUG ? performance.now() : 0;
    if (this.state === 'play' || this.state === 'choice') {
      if (this.hitstop > 0 && !this.online) {
        this.hitstop -= raw;
      } else {
        if (this.hitstop > 0) this.hitstop = Math.max(0, this.hitstop - raw);
        this.stepSimulation(raw);
      }
    }
    if (DEBUG) this.simMs = performance.now() - tSim;

    const alpha = this.state === 'play' ? clamp(this.accumulator / STEP, 0, 1) : 1;
    const tPre = DEBUG ? performance.now() : 0;
    this.present(raw, alpha);
    if (DEBUG) this.presentMs = performance.now() - tPre;

    this.lastFrameMs = performance.now() - t0;

    if (!this.online && this.me && now-this.lastDashboardFrame>500) {
      this.lastDashboardFrame=now;
      this.practiceChannel.postMessage(dashboardSnapshot(
        {code:'PRACTICE',state:this.state==='dead'?'ended':this.state==='pause'?'paused':'practice',targetPlayers:this.selectedPlayers||1},
        this.sim,this.sim.players.map(p=>({id:p.id,name:p.name,bot:p.bot,connected:true,ready:true}))));
    }
    if (DEBUG || Settings.showFps) this.drawDebug();
    else if (this._dbgShown) { this._dbgShown = false; document.getElementById('debug').style.display = 'none'; }
  }

  stepSimulation(raw) {
    this.accumulator += raw * this.slowmo;
    let steps = 0;
    while (this.accumulator >= STEP && steps++ < 5) {
      this.simStep(STEP);
      this.accumulator -= STEP;
    }
    this.lastSteps = steps;
    if (steps >= 5) this.accumulator = 0;
  }

  simStep(dt) {
    if (!this.me) return;
    this.run.time += dt;

    const targets = this.online && this.serverState
      ? this.interpolatedEnemiesForAim()
      : this.sim.enemies;

    const matchTime = this.serverState?.matchTime;
    const canAim = this.mounted && matchTime !== undefined
      ? (ax, az) => windowMuzzle(this.partySeat, matchTime, ax, az)
      : null;
    const seat = this.mounted ? VEHICLE_SEATS[this.partySeat] : null;
    const player = seat && matchTime !== undefined
      ? vehiclePoint(vehiclePose(matchTime), seat.x, seat.z) : this.me;
    const inp = this.input.sample(dt, { player, rig: this.stage, targets, canAim });
    if (this.input.takeWeaponCycle()) this.cycleWeapon();

    if (this.online) {
      if (this.partySeat && matchTime !== undefined) {
        const aim = relativeSeatAim(this.serverState.matchTime, inp.ax, inp.az);
        const allowed = allowsSeatAim(this.partySeat, aim);
        const clear = allowed && (!canAim || canAim(inp.ax, inp.az));
        const panel = document.getElementById('seatAim');
        const state = !inp.fire ? 'idle' : clear ? 'inside' : allowed ? 'blocked' : 'outside';
        panel.hidden = false;
        if (panel.dataset.aim !== state) {
          panel.dataset.aim = state;
          document.getElementById('seatAimStatus').textContent = {
            idle: '담당 구역의 적을 눌러 사격', inside: '사격 중',
            blocked: '차체에 가려짐', outside: '담당 구역 밖'
          }[state];
        }
        if (this.mounted) {
          inp.mx = inp.mz = 0;
          inp.dash = inp.ab0 = inp.ab1 = false;
        }
        inp.fire = inp.fire && clear;
      }
      this.net.pushInput(inp, dt);
      this.net.tickPing(performance.now());
      // Predict only our own player. Enemies and other players come from the
      // server, so running the whole simulation locally would fight it.
      if (this.mounted) {
        this.me.aimA = Math.atan2(inp.az, inp.ax);
      } else {
        this.sim.setInput(this.localId, { ...inp, seq: undefined });
        this.sim.stepPlayer(this.me, dt);
      }
      this.ui.net(this.net.ping, 'on');
    } else {
      this.sim.setInput(this.localId, { ...inp, seq: undefined });
      driveLocalBots(this.sim, dt);
      this.sim.step(dt);
      this.run.score = this.me.score;
      if (this.me.combo > this.run.bestCombo) this.run.bestCombo = this.me.combo;
      this.presentEvents(drainEvents(this.sim));
      this.checkLocalFlow();
    }
  }

  cycleWeapon() {
    if (!this.me || this.me.unlocked.length < 2) return;
    const k = this.me.unlocked.indexOf(this.me.weapon);
    const next = this.me.unlocked[(k + 1) % this.me.unlocked.length];
    this.input.state.weapon = next;
    this.sim.selectWeapon(this.me, next);
    this.audio.ui('tick');
  }

  /** Offline flow control: wave choice screens and death. */
  checkLocalFlow() {
    if (this.sim.over && this.state === 'play') {
      this.matchWinner = this.sim.over.winner;
      this.endRun('over');
      return;
    }
    if (!this.mode.waves) return;
    if (this.sim.director.phase === 'choice' && this.state === 'play') {
      this.state = 'choice';
      const cards = offerUpgrades(this.sim.rng, this.me, ABILITIES, 3);
      const pick = (u) => {
        if (u.kind === 'ability') this.sim.grantAbility(this.me, u.id, u.slot);
        else this.sim.applyUpgrade(this.me, u.id);
        this.ui.panel('upgradeScreen', false);
        this.state = 'play';
        for (const p of this.sim.players.filter(p=>p.bot)) { const u=offerUpgrades(this.sim.rng,p,ABILITIES,1)[0]; if(u.kind==='ability')this.sim.grantAbility(p,u.id,u.slot);else this.sim.applyUpgrade(p,u.id); }
        this.sim.director.startWave();
        this.audio.ui('ok');
        haptic(HAPTIC.ui);
      };
      this.ui.showUpgrades(cards, pick, this.run.rerolls, () => {
        if (this.run.rerolls <= 0) return;
        this.run.rerolls--;
        this.audio.ui('back');
        this.ui.showUpgrades(offerUpgrades(this.sim.rng, this.me, ABILITIES, 3), pick, this.run.rerolls, null);
      });
    }
  }

  /* ---------------------------------------------------------- PRESENTATION */

  present(dt, alpha) {
    const view = this.buildView(alpha);
    this.sim.world.animate(dt);
    if (PROBE !== 'nogl') {
      this.stage.render(dt, view, this.sim.world, this.partySeat, this.riderSeats,
        this.mode.pvp, this.damageFlash);
    }
    if (!view.player) return;

    this.audio.setListener(view.player.x, view.player.z, view.player.aimA);
    const hpFrac = view.player.hp / (view.player.maxHp || 100);
    const target = view.player.alive && !view.player.down && hpFrac < 0.35 ? 1 - hpFrac / 0.35 : 0;
    this.lowHealth = damp(this.lowHealth, target, 5, dt);
    const lh = this.lowHealth > 0.5;
    if (lh !== this._lastLow) { this._lastLow = lh; this.audio.setLowHealth(lh); }
    this.audio.tickMusic(view.intensity);

    // HUD
    if (this.state !== 'title' && this.state !== 'boot' && PROBE !== 'nohud') {
      this.ui.update(dt, {
        player: view.player, mode: this.mode, sim: view.hudSim,
        vehicle: view.vehicleHealth,
        mates: view.mates, score: this.run.score,
        maxShield: this.me ? this.me.maxShield + this.me.mods.shieldBonus : 50,
        modifier: this.sim.director.modifier ? this.sim.director.modifier.name : ''
      });
      this.ui.indicators(view.threats, this.stage);
      if (Settings.minimap && (this.frame & 1) === 0 && PROBE !== 'nomap') {
        this.ui.minimap({
          radius: this.sim.arenaRadius, shrink: view.shrink, props: this.sim.world.props,
          enemies: view.enemies, mates: view.mates, player: view.player, pvp: this.mode.pvp
        });
      }
    }
  }

  /** One place that decides what is on screen, whether the truth is local or
   *  arriving over a wire. Everything downstream reads only this. */
  buildView(alpha) {
    const v = {
      player: null, mates: [], enemies: [], projectiles: [], pickups: [], turrets: [],
      threats: [], shrink: this.sim.shrinkRadius, intensity: this.sim.director.intensity,
      hudSim: { wave: this.sim.director.wave, phase: this.sim.director.phase, intensity: this.sim.director.intensity, teamScore: this.sim.teamScore, matchTime: this.sim.matchTime }
    };
    if (!this.me) return v;

    if (this.online && this.serverState) {
      const win = this.net.interpolationWindow(performance.now());
      const s = this.serverState;
      v.shrink = s.shrink;
      v.intensity = s.intensity;
      v.hudSim = { wave: s.wave, phase: s.phase, intensity: s.intensity, teamScore: s.teamScore, matchTime: s.matchTime };

      // local player: predicted, not interpolated
      v.player = this.me;

      const blend = (a, b, t) => {
        const map = new Map(a.map(o => [o.e ?? o.id, o]));
        return b.map(o => {
          const p = map.get(o.e ?? o.id);
          if (!p) return o;
          return { ...o, x: lerp(p.x, o.x, t), z: lerp(p.z, o.z, t) };
        });
      };
      const sp = win ? blend(win.a.players, win.b.players, win.t) : s.players;
      const se = win ? blend(win.a.enemies, win.b.enemies, win.t) : s.enemies;
      const sj = win ? blend(win.a.projectiles, win.b.projectiles, win.t) : s.projectiles;

      for (const p of sp) {
        if (p.id === this.localId) continue;
        v.mates.push({
          id: p.id, name: nameFor(p.id, this), x: p.x, z: p.z, vx: p.vx, vz: p.vz,
          aimA: p.a, hp: p.hp, alive: p.alive, down: p.down, team: p.team, remote: true
        });
      }
      if (this.mounted) {
        const time = win ? lerp(win.a.matchTime, win.b.matchTime, win.t) : s.matchTime;
        v.vehicle = vehiclePose(time);
        v.vehicleHealth = s.vehicle;
        v.player = { ...this.me, ...vehiclePoint(v.vehicle, VEHICLE_SEATS[this.partySeat].x, VEHICLE_SEATS[this.partySeat].z) };
        for (const rider of v.mates) {
          const seat = VEHICLE_SEATS[this.riderSeats.get(rider.id)?.seat];
          if (seat) Object.assign(rider, vehiclePoint(v.vehicle, seat.x, seat.z));
        }
      }
      for (const e of se) {
        const def = ENEMY_TYPES[e.k] || ENEMY_TYPES.rusher;
        v.enemies.push({
          eid: e.e, key: e.k, x: e.x, z: e.z, faceA: e.a, r: def.r * def.scale,
          hpFrac: e.hp / 100, windup: e.w, buffed: e.b, spawning: e.s, flash: 0,
          vx: 0, vz: 0, elite: !!def.elite, alive: true
        });
      }
      v.projectiles = sj.map(p => ({ x: p.x, z: p.z, vx: p.vx, vz: p.vz, size: p.s, color: p.c }));
      v.pickups = s.pickups.map(p => ({ x: p.x, z: p.z, kind: p.k, t: this.time }));
      v.turrets = s.turrets;
    } else {
      v.player = { ...this.me, x: lerp(this.me.px, this.me.x, alpha), z: lerp(this.me.pz, this.me.z, alpha) };
      for (const p of this.sim.players) {
        if (p === this.me) continue;
        v.mates.push({
          id: p.id, name: p.name, x: lerp(p.px, p.x, alpha), z: lerp(p.pz, p.z, alpha),
          vx: p.vx, vz: p.vz, aimA: p.aimA, hp: p.hp, alive: p.alive, down: p.down,
          team: p.team, sim: p
        });
      }
      for (const e of this.sim.enemies) {
        if (!e.alive) continue;
        v.enemies.push({
          eid: e.eid, key: e.key, x: lerp(e.px, e.x, alpha), z: lerp(e.pz, e.z, alpha),
          faceA: e.faceA, r: e.r, hpFrac: e.hp / e.maxHp, windup: e.windup > 0,
          buffed: e.buffed > 0, spawning: e.spawnT > 0, flash: e.flash > 0 ? e.flash / 0.12 : 0,
          vx: e.vx, vz: e.vz, elite: e.elite, alive: true
        });
      }
      for (const p of this.sim.projectiles) {
        if (p.alive) v.projectiles.push(p);
      }
      for (const p of this.sim.pickups) if (p.alive) v.pickups.push(p);
      for (const t of this.sim.turrets) if (t.alive) v.turrets.push(t);
    }

    // Off-screen threat list: nearest twelve, plus any downed teammate.
    const px = v.player.x, pz = v.player.z;
    for (const e of v.enemies) {
      const d2 = dist2(e.x, e.z, px, pz);
      if (d2 > 2500) continue;
      v.threats.push({ x: e.x, z: e.z, kind: e.elite ? 'elite' : '', prox: clamp(1 - Math.sqrt(d2) / 50, 0.2, 1) });
      if (v.threats.length > 12) break;
    }
    for (const m of v.mates) if (m.down) v.threats.push({ x: m.x, z: m.z, kind: 'mate', prox: 1 });

    return v;
  }

  interpolatedEnemiesForAim() {
    const s = this.serverState;
    if (!s) return [];
    return s.enemies.map(e => {
      const def = ENEMY_TYPES[e.k] || ENEMY_TYPES.rusher;
      return { x: e.x, z: e.z, r: def.r, elite: !!def.elite, alive: true };
    }).concat(
      this.mode.pvp
        ? s.players.filter(p => p.id !== this.localId && p.alive && p.team !== (this.me ? this.me.team : -1))
          .map(p => ({ x: p.x, z: p.z, r: 0.75, elite: false, alive: true, threat: 0.5 }))
        : []
    );
  }

  /* ----------------------------------------------------- EVENT → FEEDBACK

     This is where the game acquires its texture. Every one of these lines is
     a decision about what the player should feel, and they all fire inside
     the same frame as the thing that caused them.                          */

  presentEvents(list) {
    for (const e of list) {
      this.stage.event(e);
      switch (e.t) {
        case EV.PROP_BREAK:
          if (this.online && this.sim.world.props[e.i]) this.sim.world.props[e.i].alive = false;
          break;
        case EV.SHOT: {
          this.audio.shot(e.w, e.x, e.z);
          if (e.eid !== undefined) this.audio.enemyShot(e.x, e.z);
          if (e.id === this.localId) {
            if (e.shake > 0.3) haptic(HAPTIC.shootHeavy);
            else if ((this.frame & 3) === 0) haptic(HAPTIC.shootLight);
          }
          break;
        }
        case EV.HIT:
          if (e.by === this.localId) {
            this.audio.hit(e.x, e.z, !!e.crit);
            if (e.crit) { this.hitstop = Math.max(this.hitstop, 0.026); haptic(HAPTIC.crit); }
            else if ((this.frame & 3) === 0) haptic(HAPTIC.hit);
          }
          break;
        case EV.KILL: {
          if (e.silent) break;
          const local = e.by === this.localId;
          const elite = !!e.elite || !!e.boss;
          this.audio.kill(local ? e.combo || 0 : 0, e.x, e.z, elite);
          if (local) {
            this.hitstop = Math.max(this.hitstop, e.boss ? 0.09 : elite ? 0.07 : 0.022);
            haptic(elite ? HAPTIC.killElite : HAPTIC.kill);
          }
          if (elite) this.audio.explode(e.x, e.z, !!e.boss);
          break;
        }
        case EV.EXPLODE: this.audio.explode(e.x, e.z, e.r > 7); break;
        case EV.DASH:
          this.audio.dash(e.x, e.z);
          if (e.id === this.localId) haptic(HAPTIC.dash);
          break;
        case EV.HURT:
          if (e.id === this.localId) {
            this.audio.hurt(e.x, e.z);
            haptic(HAPTIC.hurt);
            this.hitstop = Math.max(this.hitstop, 0.03);
            this.damageFlash = Settings.reducedMotion ? 0.35 : 1;
          }
          break;
        case EV.PICKUP:
          if (e.id === this.localId) { this.audio.pickup(e.kind); haptic(HAPTIC.pickup); }
          break;
        case EV.BANNER:
          this.ui.banner(/^WAVE \d+$/.test(e.a) ? '감염체 웨이브 ' + e.a.split(' ')[1] : e.clear ? '구역 확보' : e.a,
            e.clear ? '보급품을 고르고 다음 무리를 대비하세요.' : /^WAVE \d+$/.test(e.a) ? '좀비의 접근을 막고 함께 살아남으세요.' : e.b);
          if (e.big) this.audio.wave(false);
          if (e.clear) { this.audio.wave(true); if (!this.online) this.slowmoT = 1.1; }
          break;
        case EV.TELEGRAPH:
          if (e.kind === 'spawn') this.audio.spawnWarn(e.x, e.z);
          else if (['slam', 'lunge', 'suicide'].includes(e.kind)) this.audio.telegraph(e.x, e.z);
          break;
        case EV.ABILITY:
          this.audio.ability(e.x ?? this.me.x, e.z ?? this.me.z);
          if (e.ability === 'shock' && !this.online) this.hitstop = Math.max(this.hitstop, 0.06);
          if (e.ability === 'overdrive') this.ui.banner('OVERDRIVE', 'SIX SECONDS');
          if (e.id === this.localId) haptic(HAPTIC.ability);
          break;
        case EV.DOWN:
          this.ui.killFeed(`<b>${displayName(e.id, this)}</b> <span class="vs">DOWN</span>`, 'death');
          if (e.id === this.localId) {
            this.audio.down();
            haptic(HAPTIC.down);
            if (!this.online) this.slowmoT = 0.9;
          }
          break;
        case EV.REVIVE:
          if (e.id === this.localId) this.audio.revive();
          break;
        case EV.DIE: {
          this.audio.explode(e.x, e.z, true);
          const victim = displayName(e.id, this);
          const killer = e.by == null ? null : displayName(e.by, this);
          this.ui.killFeed(
            killer ? `<b>${killer}</b> <span class="vs">▸</span> <b>${victim}</b>`
              : `<b>${victim}</b> <span class="vs">ELIMINATED</span>`,
            e.by === this.localId ? 'mine' : e.id === this.localId ? 'death' : ''
          );
          if (e.id === this.localId) {
            haptic(HAPTIC.down);
            if (!this.online) {
              this.slowmoT = 1.4;
              if (!this.mode.respawn) setTimeout(() => this.endRun('died'), 200);
            }
          }
          break;
        }
        case EV.STREAK:
          if (e.id === this.localId) {
            this.audio.streak();
            haptic(HAPTIC.killElite);
            this.ui.banner(e.streak ? e.streak + ' IN A ROW' : e.combo + 'x COMBO', 'KEEP GOING');
          }
          break;
        case EV.MATCH_END: this.matchWinner = e.winner; break;
      }
    }
  }

  /* -------------------------------------------------------------- SYSTEM */

  checkOrientation() {
    const portrait = !this.mounted && window.innerHeight > window.innerWidth && matchMedia('(pointer: coarse)').matches;
    document.getElementById('rotate').classList.toggle('show', portrait && ['play', 'choice', 'pause'].includes(this.state));
    if (portrait && this.state === 'play' && !this.online) this.togglePause();
  }

  onVisibility() {
    if (document.hidden) {
      this.input.clearPointers();
      if (this.state === 'play' && !this.online) this.togglePause();
      this.audio.suspend();
    } else {
      this.lastNow = performance.now();
      this.accumulator = 0;
      this.audio.resume();
    }
  }

  drawDebug() {
    // Sampled every frame, printed rarely: an instantaneous readout is
    // unreadable at 9fps and averages hide exactly the stutter you are hunting.
    (this._dbg || (this._dbg = [])).push(this.frameIntervalMs);
    if (this._dbg.length > 120) this._dbg.shift();
    if ((this.frame & 15) !== 0) return;
    const el = document.getElementById('debug');
    el.style.display = 'block';
    this._dbgShown = true;
    if (PROBE === 'nohud') document.getElementById('hud').style.display = 'none';
    const sorted = this._dbg.slice().sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1] || 0;
    const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;

    // The plain FPS readout a player asked for. The full breakdown below it is
    // only for ?debug=1, because most of it is meaningless without the code.
    if (!DEBUG) {
      el.textContent = `${Math.round(1000 / Math.max(0.1, med))} fps   ${med.toFixed(1)}ms   p90 ${p90.toFixed(1)}ms\n` +
        `2D  dpr ${this.stage.dpr.toFixed(2)}\n`;
      return;
    }

    el.textContent =
      `frame ${med.toFixed(1)}ms (${Math.round(1000 / Math.max(0.1, med))} fps)  p90 ${p90.toFixed(1)}ms\n` +
      `cpu ${this.lastFrameMs.toFixed(2)}  sim ${(this.simMs || 0).toFixed(2)}  pres ${(this.presentMs || 0).toFixed(2)}  steps ${this.lastSteps || 0}\n` +
      `tier 2D  dpr ${this.stage.dpr.toFixed(2)}\n` +
      `enemies ${this.sim.aliveEnemies}  wave ${this.sim.director.wave}\n` +
      `intensity ${this.sim.director.intensity.toFixed(2)}  challenge ${this.sim.director.challenge.toFixed(2)}\n` +
      (this.online ? `ping ${this.net.ping}ms  tick ${this.net.serverTick}\n` : 'offline\n');
  }
}

/* ------------------------------------------------------------- HELPERS */

const STEP = 1 / T.sim.hz;
const DEBUG = new URLSearchParams(location.search).has('debug');
/* Bisection flags, debug builds only. A frame on a phone is mostly work that
   happens outside your JavaScript — DOM paint, layer compositing, the GPU
   draining the command queue — and none of it shows up in a performance.now()
   bracket around your own code. Being able to remove one whole subsystem and
   re-measure is the only way to find out which one is actually costing you. */
const PROBE = new URLSearchParams(location.search).get('probe') || '';
const BOT_NAMES = ['VIPER', 'ASH', 'KESTREL', 'NOMAD', 'RIVET', 'ONYX', 'FLINT'];

function drainEvents(sim) {
  const out = [];
  sim.events.drain(e => out.push(e));
  return out;
}

function nameFor(id, app) {
  const riderName = app.partySeat && app.riderSeats.get(id)?.name;
  if (riderName) return riderName;
  const p = app.sim.playerById(id);
  return p ? p.name : 'RUNNER';
}

function displayName(id, app) {
  return id === app.localId ? 'YOU' : nameFor(id, app).replace(/[&<>]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;'
  })[char]);
}

function endReason(over) {
  switch (over.reason) {
    case 'score': return 'SCORE LIMIT — ' + (TEAM_NAMES[over.winner] || '');
    case 'time': return 'TIME — ' + (TEAM_NAMES[over.winner] || '');
    case 'lastsquad': return 'LAST SQUAD STANDING';
    case 'wipe': return 'THE ARENA KEEPS THE SCORE';
    default: return '';
  }
}

function levelFromXp(xp) {
  return Math.max(1, Math.floor(Math.log(Math.max(1, xp) / T.progression.baseLevelXp) / Math.log(T.progression.levelCurve)) + 1);
}
function xpProgress(xp) {
  const lv = levelFromXp(xp);
  const at = T.progression.baseLevelXp * Math.pow(T.progression.levelCurve, lv - 1);
  const next = T.progression.baseLevelXp * Math.pow(T.progression.levelCurve, lv);
  return clamp((xp - at) / Math.max(1, next - at), 0, 1);
}

/** Offline PvP opponents. Deliberately readable rather than optimal: a bot
 *  that never misses is not a practice partner, it is a wall. */
function driveLocalBots(sim, dt) {
  for (const p of sim.players) {
    if (!p.bot || !p.alive || p.down) continue;
    p._t = (p._t || 0) + dt;

    let target = null, bd = Infinity;
    for (const o of sim.players) {
      if (o === p || !o.alive || o.down || o.team === p.team) continue;
      const d = dist2(o.x, o.z, p.x, p.z);
      if (d < bd) { bd = d; target = o; }
    }
    if (!target) {
      for (const e of sim.enemies) {
        if (!e.alive) continue;
        const d = dist2(e.x, e.z, p.x, p.z);
        if (d < bd) { bd = d; target = e; }
      }
    }
    if (!target) { sim.setInput(p.id, { mx: Math.cos(p._t), mz: Math.sin(p._t * 1.3), ax: 1, az: 0, fire: false }); continue; }

    const dx = target.x - p.x, dz = target.z - p.z;
    const d = Math.sqrt(bd) || 1;
    const nx = dx / d, nz = dz / d;
    // Strafe around the target rather than walking into it.
    const orbit = Math.sin(p._t * 0.8) > 0 ? 1 : -1;
    const want = d > 16 ? 1 : d < 8 ? -0.6 : 0.1;
    const mx = nx * want - nz * orbit * 0.75;
    const mz = nz * want + nx * orbit * 0.75;
    const ml = Math.hypot(mx, mz) || 1;

    // Aim error that shrinks as the bot "settles", so strafing beats it.
    const err = (Math.sin(p._t * 3.1) * 0.10 + (Math.random() - 0.5) * 0.06);
    const a = Math.atan2(nz, nx) + err;

    sim.setInput(p.id, {
      mx: mx / ml, mz: mz / ml,
      ax: Math.cos(a), az: Math.sin(a),
      fire: d < 30,
      dash: Math.random() < 0.004 || (p.hp < 40 && Math.random() < 0.01),
      ab0: Math.random() < 0.002,
      weapon: p.weapon
    });
  }
}

/* ------------------------------------------------------------ PLATFORM */

function lockOrientation() {
  try {
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
  } catch (e) { void e; }
}

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { void e; }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && wakeLock === null) requestWakeLock();
});

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------- GO */

const app = new App();
window.__overrun = app;
app.boot().catch(err => {
  console.error(err);
  document.getElementById('bootText').textContent = 'FAILED TO START — ' + (err && err.message);
});

// Service worker: registered late so it never competes with the first frame.
// Secure contexts only, which includes localhost — the old check was https
// alone, so the service worker never registered during local development and
// the offline path could not be tested without deploying it.
if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then(rs=>rs.forEach(r=>r.unregister()));

void UPGRADES; void makeRng; void Rings;
