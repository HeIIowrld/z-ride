'use strict';
/**
 * Z-RIDE 차량 연동 SDK (브리지 v1). 게임의 큰 화면 페이지에 이 파일 하나만 넣으면 된다.
 *
 *   <script src="/zride-car.js"></script>
 *   const car = ZRide.car;
 *   car.on('signal', s => { ... s.soc, s.gear, s.parked, s.speedKmh ... });
 *   car.setCabin({ light: 'RED', air: 'GUST' });
 *   car.pulse('RED', 800);
 *
 * - Pleos 허브 앱 안에서 열리면 실제 차 신호가 온다(car.inCar === true).
 * - 일반 브라우저에서는 신호가 없다(car.state === null). 주소에 ?mockcar 를 붙이면
 *   화면 구석에 가짜 차 패널(배터리·기어·속도)이 떠서 차 없이 개발할 수 있다.
 * - 실내 연출은 P단·화면 표시 중일 때만 적용된다. 주차가 풀리면 앱이 원래 값으로 되돌리고,
 *   다시 주차되면 SDK가 마지막 요청을 다시 보낸다.
 * 명세: games/sdk/README.md
 */
(() => {
  const VERSION = 1;
  const LIGHTS = ['NORMAL', 'OFF', 'RED', 'BLUE', 'GREEN', 'YELLOW', 'PURPLE'];
  const CLIMATES = ['NORMAL', 'COLD', 'WARM'];
  const AIRS = ['NORMAL', 'LOW', 'GUST'];
  const NORMAL = { light: 'NORMAL', climate: 'NORMAL', air: 'NORMAL' };
  const isNormal = c => c.light === 'NORMAL' && c.climate === 'NORMAL' && c.air === 'NORMAL';
  const native = window.ZRideCar ?? null;
  const listeners = new Set();
  let state = null, wanted = { ...NORMAL }, pulseTimer = null, mock = null;

  function emit(next) {
    const wasParked = state?.parked;
    state = Object.freeze({ ...next });
    // 주차가 풀렸다가 다시 되면 앱은 원래 값으로 돌아가 있다. 마지막 요청을 다시 보낸다.
    if (state.parked && !wasParked && !isNormal(wanted)) send(wanted);
    for (const fn of listeners) { try { fn(state); } catch (e) { console.error(e); } }
  }
  // 네이티브 앱이 부르는 입구. 직접 부르지 않는다.
  window.__zrideCar = value => { if (value && value.v === VERSION) emit(value); };

  function send(cabin) {
    if (native) return native.setCabin(JSON.stringify(cabin));
    if (mock) { mock.show(cabin); return !!state?.parked; }
    return false;
  }

  const car = {
    version: VERSION,
    lights: LIGHTS, climates: CLIMATES, airs: AIRS,
    /** Pleos 허브 앱 안인지. */
    get inCar() { return !!native; },
    /** 가짜 차 패널을 쓰는 중인지. */
    get mocked() { return !!mock; },
    /** 마지막 차 신호. 차가 없으면 null. {soc, gear, ux, speedKmh, visible, parked} */
    get state() { return state; },
    /** 마지막으로 요청한 실내 상태. */
    get cabin() { return { ...wanted }; },
    get info() { try { return native ? JSON.parse(native.info()) : { version: VERSION, app: null, gameId: null, lights: LIGHTS, climates: CLIMATES, airs: AIRS }; } catch { return null; } },
    /** on('signal', fn): 차 신호가 바뀔 때마다. 이미 신호가 있으면 바로 한 번 부른다. 해제 함수를 돌려준다. */
    on(type, fn) {
      if (type !== 'signal') throw new Error('unknown event ' + type);
      listeners.add(fn);
      // 등록한 코드가 다 실행된 뒤에 부른다(같은 줄에서 아직 정의 안 된 함수를 쓰는 경우 대비)
      if (state) setTimeout(() => { if (listeners.has(fn) && state) fn(state); }, 0);
      return () => listeners.delete(fn);
    },
    /**
     * 실내 상태 요청. 빠진 값은 지금 요청을 유지한다. NORMAL은 원래 값으로.
     * 지금 적용됐으면 true, 주차 중이 아니거나 차가 없으면 false(요청은 기억했다가 주차되면 적용).
     */
    setCabin({ light = wanted.light, climate = wanted.climate, air = wanted.air } = {}) {
      if (!LIGHTS.includes(light)) throw new Error('light must be one of ' + LIGHTS.join(','));
      if (!CLIMATES.includes(climate)) throw new Error('climate must be one of ' + CLIMATES.join(','));
      if (!AIRS.includes(air)) throw new Error('air must be one of ' + AIRS.join(','));
      clearTimeout(pulseTimer); pulseTimer = null;
      wanted = { light, climate, air };
      return send(wanted);
    },
    /** 무드등을 잠깐(최대 5초) 바꿨다가 요청 상태로 돌아간다. 피격·경고 같은 짧은 신호용. */
    pulse(light = 'RED', ms = 800) {
      if (!LIGHTS.includes(light)) throw new Error('light must be one of ' + LIGHTS.join(','));
      clearTimeout(pulseTimer);
      const ok = send({ ...wanted, light });
      pulseTimer = setTimeout(() => { pulseTimer = null; send(wanted); }, Math.max(100, Math.min(5000, ms)));
      return ok;
    },
    /** 실내를 원래대로. 게임이 끝날 때 부른다. */
    reset() { return car.setCabin(NORMAL); },
    /** 허브 게임 목록으로 돌아간다(차 밖에서는 아무 일 없음). */
    exit() { if (native) native.exit(); },
  };

  /**
   * 차 없이 개발할 때 쓰는 가짜 차 패널. 게임 CSS·CSP(style-src 'self')에 영향받지 않게
   * Shadow DOM과 생성형 스타일시트를 쓰고, 인라인 style 속성은 쓰지 않는다.
   */
  function startMock() {
    const COLORS = { NORMAL: '#ddd', OFF: '#111', RED: '#ff2020', BLUE: '#2060ff', GREEN: '#20e060', YELLOW: '#ffd020', PURPLE: '#a040ff' };
    const host = document.createElement('zride-mockcar');
    const shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host { all: initial; position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; }
      .box { background: #0b0f16ee; color: #e8edf5; font: 13px/1.5 system-ui, sans-serif; border: 1px solid #334; border-radius: 12px; padding: 10px 12px; width: 230px; box-shadow: 0 6px 24px #0008; }
      b { display: block; margin-bottom: 4px; }
      .row { display: flex; align-items: center; gap: 4px; margin-top: 6px; }
      .row span.grow { flex: 1; }
      input { width: 100%; margin: 2px 0 0; }
      button { min-width: 30px; border-radius: 6px; border: 1px solid #556; background: #1b2230; color: #e8edf5; font: inherit; padding: 2px 0; cursor: pointer; }
      button.on { background: #ffd640; color: #111; }
      .dot { width: 14px; height: 14px; border-radius: 50%; border: 1px solid #889; }
    `);
    shadow.adoptedStyleSheets = [sheet];
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const box = el('div', 'box');
    const sim = { soc: 40, gear: 'P', speedKmh: 0 };
    const socText = el('span', 'grow'), speedText = el('span', 'grow');
    const socIn = el('input'); socIn.type = 'range'; socIn.min = 0; socIn.max = 100; socIn.value = sim.soc;
    const speedIn = el('input'); speedIn.type = 'range'; speedIn.min = 0; speedIn.max = 120; speedIn.value = 0;
    const gearRow = el('div', 'row'); gearRow.append(el('span', 'grow', '기어'));
    const gearButtons = ['P', 'R', 'N', 'D'].map(g => {
      const b = el('button', '', g); b.type = 'button';
      b.onclick = () => { sim.gear = g; if (g === 'P') sim.speedKmh = 0; update(); };
      gearRow.append(b); return b;
    });
    const dot = el('span', 'dot'), cabinText = el('span', 'grow');
    const socRow = el('div', 'row'); socRow.append(socText);
    const speedRow = el('div', 'row'); speedRow.append(speedText);
    const cabinRow = el('div', 'row'); cabinRow.append(dot, cabinText);
    box.append(el('b', '', '가짜 차 (mockcar)'), socRow, socIn, gearRow, speedRow, speedIn, cabinRow);
    shadow.append(box);
    socIn.oninput = () => { sim.soc = Number(socIn.value); update(); };
    speedIn.oninput = () => { sim.speedKmh = Number(speedIn.value); if (sim.speedKmh > 0 && sim.gear === 'P') sim.gear = 'D'; update(); };
    const view = { ...NORMAL };
    function paint() {
      dot.style.background = COLORS[view.light]; // CSSOM 대입은 CSP에 막히지 않는다
      cabinText.textContent = `실내 ${view.light} · 바람 ${view.air} · 온도 ${view.climate}`;
    }
    function update() {
      const parked = sim.gear === 'P';
      socText.textContent = `배터리 ${sim.soc}%`;
      speedText.textContent = `속도 ${sim.speedKmh} km/h`;
      speedIn.value = sim.speedKmh;
      gearButtons.forEach(b => b.classList.toggle('on', b.textContent === sim.gear));
      if (!parked) { Object.assign(view, NORMAL); paint(); } // 앱처럼 주차가 풀리면 원래대로
      emit({ v: VERSION, soc: sim.soc, gear: sim.gear, ux: parked ? 'ALLOWED' : 'RESTRICTED', speedKmh: sim.speedKmh, visible: true, parked });
    }
    mock = { show(cabin) { if (!state?.parked) return; Object.assign(view, cabin); paint(); } };
    const mount = () => { document.body.append(host); paint(); update(); };
    if (document.body) mount(); else addEventListener('DOMContentLoaded', mount);
  }

  if (!native && /[?&]mockcar\b/.test(location.search)) startMock();
  window.ZRide = Object.assign(window.ZRide ?? {}, { car });
})();
