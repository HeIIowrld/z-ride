'use strict';
const JOURNEY_MAP_BASE = document.currentScript ? new URL('.', document.currentScript.src) : new URL('/play/', location.href);

// 화면 모서리가 비지 않도록 뷰포트 대각선만큼 큰 정사각형에 지도를 그리고 CSS로 돌린다.
// 마커는 --upright로 반대로 돌려 방향을 유지한다.
function createJourneyMap(plot, recenter, tileStatus, retry, selectSpots, extra = {}) {
  const defaultCenter = [37.5665, 126.978];
  const followZoom = 16;
  const config = Object.assign({ size: 40, readySize: 46, games: {},
    destinationIcon: 'route-sign/destination.svg', destinationWidth: 28 }, window.PLY_ROUTE_SIGN || {});
  const asset = path => new URL(path, JOURNEY_MAP_BASE).href;
  const toRad = value => value * Math.PI / 180;
  const coords = point => [point.latitude, point.longitude];

  const rotor = document.createElement('div');
  rotor.className = 'journey-rotor';
  plot.append(rotor);
  const map = L.map(rotor, {
    minZoom: 6, maxZoom: 19, zoomControl: false, attributionControl: false,
    scrollWheelZoom: false, touchZoom: 'center', doubleClickZoom: 'center', keyboard: false,
  });
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 });
  const routeLayer = L.layerGroup().addTo(map);
  const pins = L.layerGroup().addTo(map);
  const signLayer = L.layerGroup().addTo(map);

  const carElement = document.createElement('div');
  carElement.className = 'journey-car-arrow';
  carElement.innerHTML = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" class="halo"/>' +
    '<path d="M20 6 31 31 20 25 9 31Z" class="arrow"/></svg>';
  const car = L.marker(defaultCenter, {
    icon: L.divIcon({ className: 'journey-map-marker', html: carElement, iconSize: [0, 0] }),
    interactive: false, keyboard: false, zIndexOffset: 2000,
  });

  let position, spots = [], selectedId, spotSignature, routeKey, routeSignature, signSignature;
  let following = true, resumeTimer;
  let shown = null, carHeading = 0, targetHeading = 0, viewHeading = 0, anim = null, lastFixAt = 0, frame = 0;
  let failed = 0, loaded = 0, tileTimeout, pinTimer;

  const rotorSize = () => Math.ceil(Math.hypot(plot.clientWidth, plot.clientHeight)) + 4;
  function layoutRotor() {
    const d = rotorSize();
    rotor.style.width = rotor.style.height = d + 'px';
    rotor.style.left = (plot.clientWidth - d) / 2 + 'px';
    rotor.style.top = (plot.clientHeight - d) / 2 + 'px';
  }
  function applyRotation() {
    rotor.style.transform = 'rotate(' + (-viewHeading).toFixed(2) + 'deg)';
    rotor.style.setProperty('--upright', viewHeading.toFixed(2) + 'deg');
    // 화살표는 지도와 함께 회전하므로 화면 방향은 carHeading - viewHeading이다.
    carElement.style.transform = 'translate(-50%, -50%) rotate(' + carHeading.toFixed(2) + 'deg)';
  }
  layoutRotor();
  // 회전된 상태에서 드래그: 화면 이동량 → 지도(회전 전) 좌표 이동량
  map.dragging._draggable.on('predrag', () => {
    const drag = map.dragging._draggable, event = drag._lastEvent;
    if (!event || !drag._startPoint) return;
    const point = event.touches && event.touches.length === 1 ? event.touches[0] : event;
    const dx = point.clientX - drag._startPoint.x, dy = point.clientY - drag._startPoint.y;
    const c = Math.cos(toRad(viewHeading)), s = Math.sin(toRad(viewHeading));
    drag._newPos = drag._startPos.add(L.point(dx * c - dy * s, dx * s + dy * c));
  });

  tiles.on('loading', () => {
    failed = 0;
    loaded = 0;
    clearTimeout(tileTimeout);
    tileTimeout = setTimeout(() => { if (!loaded) tileStatus.hidden = false; }, 8000);
  });
  tiles.on('tileload', () => { loaded++; tileStatus.hidden = true; });
  tiles.on('tileerror', () => { failed++; });
  tiles.on('load', () => {
    clearTimeout(tileTimeout);
    tileStatus.hidden = !failed || loaded > 0;
  });
  retry.onclick = () => tiles.redraw();

  function bearing(a, b) {
    const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
    const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) -
      Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  const turn = (from, to) => ((to - from + 540) % 360) - 180;

  // 차량이 화면 아래쪽(높이의 75%)에 오도록 지도 중심을 진행 방향 앞으로 옮긴다.
  function followCenter(latlng) {
    const zoom = map.getZoom();
    const lead = plot.clientHeight * 0.25;
    const point = map.project(latlng, zoom).add([Math.sin(toRad(viewHeading)) * lead, -Math.cos(toRad(viewHeading)) * lead]);
    return map.unproject(point, zoom);
  }
  function applyFollow() {
    if (!following || !shown) return;
    map.setView(followCenter(shown), map.getZoom(), { animate: false });
  }
  function setFollowing(value) {
    following = value;
    clearTimeout(resumeTimer);
    recenter.hidden = !position || following;
    if (following) kick();
  }
  function resumeFollowing() {
    if (!position) return;
    setFollowing(true);
    if (map.getZoom() < 14) map.setZoom(followZoom, { animate: false });
    applyFollow();
  }
  function scheduleResume() {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(resumeFollowing, 15000);
  }

  function tick(now) {
    frame = 0;
    let moving = false;
    if (anim) {
      const t = Math.min(1, (now - anim.start) / anim.duration);
      shown = L.latLng(anim.from.lat + (anim.to.lat - anim.from.lat) * t, anim.from.lng + (anim.to.lng - anim.from.lng) * t);
      car.setLatLng(shown);
      if (t >= 1) anim = null; else moving = true;
    }
    const carDiff = turn(carHeading, targetHeading);
    if (Math.abs(carDiff) > 0.3) { carHeading = (carHeading + carDiff * 0.15 + 360) % 360; moving = true; }
    else carHeading = targetHeading;
    // 사용자가 지도를 둘러보는 동안에는 회전을 멈춘다.
    if (following) {
      const viewDiff = turn(viewHeading, carHeading);
      if (Math.abs(viewDiff) > 0.3) { viewHeading = (viewHeading + viewDiff * 0.12 + 360) % 360; moving = true; }
      else viewHeading = carHeading;
    }
    applyRotation();
    applyFollow();
    if (moving) frame = requestAnimationFrame(tick);
  }
  function kick() { if (!frame) frame = requestAnimationFrame(tick); }

  function renderPins() {
    pins.clearLayers();
    if (!position) return;
    const bounds = map.getPixelBounds();
    const clusters = [];
    for (const spot of spots) {
      if (!Number.isFinite(spot.latitude) || !Number.isFinite(spot.longitude) ||
          !bounds.contains(map.project(coords(spot)))) continue;
      const pixel = map.latLngToLayerPoint(coords(spot));
      const cluster = clusters.find(({ pixel: anchor }) => Math.abs(anchor.x - pixel.x) < 110 &&
        Math.abs(anchor.y - pixel.y) < 46);
      if (cluster) cluster.entries.push(spot);
      else clusters.push({ pixel, entries: [spot] });
    }
    for (const { entries } of clusters) {
      const primary = entries[0];
      const selected = entries.some(spot => spot.placeId === selectedId);
      const supply = primary.activity === 'supply';
      const grouped = entries.length > 1;
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'journey-pin';
      pin.classList.toggle('spot-active', Boolean(primary.activity));
      if (supply) {
        pin.classList.add('supply-pin');
        pin.append(document.createElement('ply-supply-icon'));
      }
      const label = document.createElement('span');
      label.className = 'journey-pin-label';
      label.textContent = supply ? '보급품 +1' : primary.activity === 'charge' ? primary.detail :
        grouped ? '주변 장소' : primary.label;
      pin.append(label);
      if (grouped) {
        const count = document.createElement('span');
        count.className = 'cluster-count';
        count.textContent = entries.length + '곳';
        pin.append(count);
      }
      pin.setAttribute('aria-label', grouped ? label.textContent + ' · ' + entries.length + '곳 보기'
        : primary.label + ' · ' + primary.detail);
      pin.setAttribute('aria-pressed', String(selected));
      L.DomEvent.disableClickPropagation(pin);
      pin.onclick = () => selectSpots(entries);
      L.marker(coords(primary), {
        keyboard: false,
        zIndexOffset: primary.activity ? 1200 : 0,
        icon: L.divIcon({ className: 'journey-map-marker', html: pin, iconSize: [0, 0] }),
      }).addTo(pins);
    }
  }
  function schedulePins() {
    if (pinTimer) return;
    pinTimer = setTimeout(() => { pinTimer = null; renderPins(); }, 600);
  }

  let routePoints = [], routeCum = [], passedLine;
  function cumulative(points) {
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + map.distance(points[i - 1], points[i]));
    return cum;
  }
  function splitAt(progressM) {
    if (routePoints.length < 2) return [];
    const target = Math.max(0, Math.min(progressM, routeCum.at(-1)));
    const passed = [routePoints[0]];
    for (let i = 1; i < routePoints.length; i++) {
      if (routeCum[i] <= target) { passed.push(routePoints[i]); continue; }
      const span = routeCum[i] - routeCum[i - 1] || 1, t = (target - routeCum[i - 1]) / span;
      const a = routePoints[i - 1], b = routePoints[i];
      passed.push(L.latLng(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t));
      break;
    }
    return passed;
  }
  function renderRoute(route) {
    const key = route?.status === 'READY' ? route.key : null;
    if (key !== routeKey) {
      routeKey = key;
      routeSignature = null;
      routeLayer.clearLayers();
      passedLine = null;
      routePoints = key ? route.geometry.map(coords).map(p => L.latLng(p)) : [];
      routeCum = cumulative(routePoints);
      if (key) {
        const style = { interactive: false, lineCap: 'round', lineJoin: 'round' };
        L.polyline(routePoints, { ...style, color: '#0b2f6b', weight: 11, opacity: .95 }).addTo(routeLayer);
        L.polyline(routePoints, { ...style, className: 'route-line', color: '#2f86ff', weight: 7, opacity: 1 }).addTo(routeLayer);
        passedLine = L.polyline([], { ...style, color: '#8c97a8', weight: 7, opacity: 1 }).addTo(routeLayer);
        const flag = document.createElement('img');
        flag.className = 'journey-destination';
        flag.src = asset(config.destinationIcon);
        flag.alt = '도착';
        flag.style.width = config.destinationWidth + 'px';
        L.marker(routePoints.at(-1), {
          icon: L.divIcon({ className: 'journey-map-marker', html: flag, iconSize: [0, 0] }),
          interactive: false, keyboard: false, zIndexOffset: 900,
        }).addTo(routeLayer);
      }
    }
    if (passedLine && route.progressM !== routeSignature) {
      routeSignature = route.progressM;
      passedLine.setLatLngs(splitAt(route.progressM));
    }
  }

  function renderSigns(route, selectedSignId) {
    const signs = route?.status === 'READY' ? route.signs : [];
    const signature = JSON.stringify([signs.map(s => [s.signId, s.gameId, s.state, s.latitude, s.longitude]), selectedSignId]);
    if (signature === signSignature) return;
    signSignature = signature;
    signLayer.clearLayers();
    for (const [index, sign] of signs.entries()) {
      const game = config.games[sign.gameId];
      if (!game) continue;
      const ready = sign.state === 'READY';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'route-sign route-sign-' + sign.state.toLowerCase();
      button.setAttribute('aria-pressed', String(sign.signId === selectedSignId));
      button.setAttribute('aria-label', game.label + ' 표지판 ' + (index + 1) + '/' + signs.length);
      button.style.setProperty('--sign-size', (ready ? config.readySize : config.size) + 'px');
      const image = document.createElement('img');
      image.src = asset(config.icons?.[sign.gameId] ?? config.icon);
      image.alt = '';
      image.draggable = false;
      button.append(image);
      L.DomEvent.disableClickPropagation(button);
      button.onclick = () => extra.selectSign?.(sign);
      L.marker(coords(sign), {
        keyboard: false,
        zIndexOffset: ready ? 1500 : sign.state === 'AHEAD' ? 1100 : 500,
        icon: L.divIcon({ className: 'journey-map-marker', html: button, iconSize: [0, 0] }),
      }).addTo(signLayer);
    }
  }

  map.on('dragstart', () => setFollowing(false));
  map.on('dragend', scheduleResume);
  map.on('zoomend', () => { if (following) applyFollow(); renderPins(); });
  map.on('moveend', schedulePins);
  recenter.onclick = resumeFollowing;
  if (extra.zoomIn) extra.zoomIn.onclick = () => { map.zoomIn(1, { animate: false }); applyFollow(); };
  if (extra.zoomOut) extra.zoomOut.onclick = () => { map.zoomOut(1, { animate: false }); applyFollow(); };

  return {
    update(nextPosition, nextSpots, nextSelected, options = {}) {
      const firstFix = !position && nextPosition;
      const moved = position?.latitude !== nextPosition?.latitude || position?.longitude !== nextPosition?.longitude;
      const previous = position;
      position = nextPosition;
      spots = nextSpots;
      selectedId = nextSelected;
      if (Math.abs(parseFloat(rotor.style.width) - rotorSize()) > 1) {
        layoutRotor();
        map.invalidateSize({ animate: false, pan: false });
      }
      if (!map.hasLayer(tiles)) {
        map.setView(position ? coords(position) : defaultCenter, followZoom);
        tiles.addTo(map);
      }
      if (position) {
        const target = L.latLng(coords(position));
        if (Number.isFinite(options.heading)) targetHeading = options.heading;
        else if (previous && moved && map.distance(coords(previous), target) > 2) targetHeading = bearing(coords(previous), coords(position));
        if (!map.hasLayer(car)) car.addTo(map);
        const now = performance.now();
        if (firstFix || !shown) {
          shown = target;
          carHeading = viewHeading = targetHeading;
          car.setLatLng(target);
          applyRotation();
          map.setView(followCenter(target), followZoom, { animate: false });
        } else if (moved) {
          const duration = Math.max(400, Math.min(2500, now - lastFixAt));
          anim = { from: car.getLatLng(), to: target, start: now, duration };
        }
        if (moved || firstFix) lastFixAt = now;
        kick();
      } else {
        car.remove();
        shown = null;
      }
      recenter.hidden = !position || following;
      renderRoute(options.route);
      renderSigns(options.route, options.selectedSignId);
      const signature = JSON.stringify([spots, selectedId]);
      if (signature !== spotSignature) renderPins();
      spotSignature = signature;
    },
  };
}
