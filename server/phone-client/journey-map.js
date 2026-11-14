'use strict';

function createJourneyMap(plot, recenter, tileStatus, retry, selectSpot) {
  const defaultCenter = [37.5665, 126.978];
  const defaultZoom = 15;
  const map = L.map(plot, { minZoom: 6, maxZoom: 19, scrollWheelZoom: false,
    attributionControl: false });
  L.control.attribution({ prefix: false }).addTo(map);
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  const pins = L.layerGroup().addTo(map);
  const carLabel = document.createElement('span');
  carLabel.className = 'journey-car';
  carLabel.textContent = '내 차량';
  const car = L.marker(defaultCenter, {
    icon: L.divIcon({ className: 'journey-map-marker', html: carLabel, iconSize: [0, 0] }),
    interactive: false, keyboard: false, zIndexOffset: 1000,
  });
  let position, spots = [], selectedId, following = true, spotSignature;
  let failed = 0, loaded = 0, tileTimeout;
  const coords = point => [point.latitude, point.longitude];

  tiles.on('loading', () => {
    failed = 0;
    loaded = 0;
    clearTimeout(tileTimeout);
    tileTimeout = setTimeout(() => { if (!loaded) tileStatus.hidden = false; }, 8000);
  });
  tiles.on('tileload', () => {
    loaded++;
    tileStatus.hidden = true;
  });
  tiles.on('tileerror', () => { failed++; });
  tiles.on('load', () => {
    clearTimeout(tileTimeout);
    tileStatus.hidden = !failed || loaded > 0;
  });
  retry.onclick = () => tiles.redraw();

  function renderPins() {
    pins.clearLayers();
    if (!position) return;
    const bounds = map.getPixelBounds();
    const carPoint = map.latLngToLayerPoint(coords(position));
    const clusters = [];
    for (const [index, spot] of spots.entries()) {
      if (!Number.isFinite(spot.latitude) || !Number.isFinite(spot.longitude) ||
          !bounds.contains(map.project(coords(spot)))) continue;
      const pixel = map.latLngToLayerPoint(coords(spot));
      const cluster = clusters.find(group => group.pixel.distanceTo(pixel) < 36);
      const entry = { spot, index };
      if (cluster) cluster.entries.push(entry);
      else clusters.push({ pixel, entries: [entry] });
    }
    for (const { pixel, entries } of clusters) {
      const selected = entries.findIndex(({ spot }) => spot.placeId === selectedId);
      const { spot, index } = entries[selected < 0 ? 0 : (selected + 1) % entries.length];
      const supply = entries.some(entry => entry.spot.activity === 'supply');
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'journey-pin' + (entries.some(entry => entry.spot.activity) ? ' spot-active' : '');
      if (supply) {
        pin.classList.add('supply-pin');
        pin.append(document.createElement('ply-supply-icon'));
        if (entries.length > 1) {
          const count = document.createElement('span');
          count.className = 'cluster-count';
          count.textContent = entries.length;
          count.setAttribute('aria-hidden', 'true');
          pin.append(count);
        }
      } else pin.textContent = entries.length > 1 ? '+' + entries.length : String(index + 1);
      pin.setAttribute('aria-label', (entries.length > 1 ? entries.length + '개 장소 · 다음 장소 ' : '') + spot.label);
      pin.setAttribute('aria-pressed', String(selected >= 0));
      L.DomEvent.disableClickPropagation(pin);
      pin.onclick = () => selectSpot(spot);
      // Keep the actual marker anchored to the map point. If it overlaps the car,
      // move its button up and show a stem back to the point.
      if (carPoint.distanceTo(pixel) < 28) pin.classList.add('journey-pin-offset');
      L.marker(map.layerPointToLatLng(pixel), {
        keyboard: false,
        icon: L.divIcon({ className: 'journey-map-marker', html: pin, iconSize: [0, 0] }),
      }).addTo(pins);
    }
  }

  map.on('dragstart zoomstart', () => { following = false; });
  map.on('moveend', renderPins);
  recenter.onclick = () => {
    if (!position) return;
    map.setView(coords(position), defaultZoom, { animate: false });
    following = true;
  };
  return {
    update(nextPosition, nextSpots, nextSelected) {
      const firstFix = !position && nextPosition;
      const moved = position?.latitude !== nextPosition?.latitude || position?.longitude !== nextPosition?.longitude;
      position = nextPosition;
      spots = nextSpots;
      selectedId = nextSelected;
      recenter.hidden = !position;
      if (!map.hasLayer(tiles)) {
        map.setView(position ? coords(position) : defaultCenter, defaultZoom);
        tiles.addTo(map);
      }
      if (position) {
        car.setLatLng(coords(position));
        if (!map.hasLayer(car)) car.addTo(map);
      } else car.remove();
      const movedMap = position && (firstFix || (following && moved &&
        !map.getBounds().pad(-.27).contains(coords(position))));
      if (movedMap) map.panTo(coords(position), { animate: false });
      const signature = JSON.stringify([spots, selectedId]);
      if (moved || signature !== spotSignature) renderPins();
      spotSignature = signature;
      if (map.getSize().x !== plot.clientWidth || map.getSize().y !== plot.clientHeight) {
        map.invalidateSize({ animate: false, pan: false });
      }
    },
  };
}
