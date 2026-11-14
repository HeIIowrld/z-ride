'use strict';

function createJourneyMap(plot, recenter, tileStatus, retry, selectSpots) {
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
    for (const spot of spots) {
      if (!Number.isFinite(spot.latitude) || !Number.isFinite(spot.longitude) ||
          !bounds.contains(map.project(coords(spot)))) continue;
      const pixel = map.latLngToLayerPoint(coords(spot));
      const cluster = clusters.find(({ pixel: anchor }) => Math.abs(anchor.x - pixel.x) < 110 &&
        Math.abs(anchor.y - pixel.y) < 46);
      if (cluster) cluster.entries.push(spot);
      else clusters.push({ pixel, entries: [spot] });
    }
    for (const { pixel, entries } of clusters) {
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
      // Keep the actual marker anchored to the map point. If it overlaps the car,
      // move its button up and show a stem back to the point.
      if (Math.abs(carPoint.x - pixel.x) < 65 && Math.abs(carPoint.y - pixel.y) < 38)
        pin.classList.add('journey-pin-offset');
      const anchor = map.getPixelOrigin().add(pixel);
      pin.classList.toggle('journey-pin-left', anchor.x < bounds.min.x + 62);
      pin.classList.toggle('journey-pin-right', anchor.x > bounds.max.x - 62);
      L.marker(coords(primary), {
        keyboard: false,
        zIndexOffset: primary.activity ? 1200 : 0,
        icon: L.divIcon({ className: 'journey-map-marker', html: pin, iconSize: [0, 0] }),
      }).addTo(pins);
    }
  }

  map.on('dragstart', () => { following = false; });
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
