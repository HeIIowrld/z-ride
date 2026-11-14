import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { distanceMeters } from './world.mjs';
import { createEventLedger } from './event-ledger.mjs';

const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const finite = Number.isFinite;
const clone = value => structuredClone(value);
export function coordinate(p) {
  if (!p || !finite(p.latitude) || !finite(p.longitude) || Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180) throw fail('INVALID_COORDINATE', 'WGS84 latitude/longitude required');
  return { latitude: p.latitude, longitude: p.longitude };
}
export function distanceToRoute(point, geometry) {
  const lat = point.latitude * Math.PI / 180, scale = Math.PI * 6371008.8 / 180;
  let best = Infinity;
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1], b = geometry[i];
    const ax = (a.longitude - point.longitude) * scale * Math.cos(lat), ay = (a.latitude - point.latitude) * scale;
    const bx = (b.longitude - point.longitude) * scale * Math.cos(lat), by = (b.latitude - point.latitude) * scale;
    const dx = bx - ax, dy = by - ay, square = dx * dx + dy * dy;
    const t = square ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / square)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
export function createPlacesService({ catalogPath, catalog, clock = Date.now, routeTtlMs = 1800000, eventPolicy = {} } = {}) {
  const data = catalog ?? (catalogPath ? JSON.parse(readFileSync(catalogPath, 'utf8')) : { version: 'not-imported', places: [] });
  if (typeof data.version !== 'string' || !Array.isArray(data.places)) throw new Error('Invalid place catalog');
  const places = new Map(data.places.map(p => { coordinate(p); if (!p.placeId || !['ATTRACTION','PARKING','CHARGER','FUEL_STATION'].includes(p.category)) throw new Error('Invalid catalog entry'); return [p.placeId, p]; }));
  if (places.size !== data.places.length) throw new Error('Duplicate catalog ID');
  const routes = new Map(), inviteIds = new Map();
  const events=createEventLedger({clock,...eventPolicy});
  let state = { revision: 0, reviews: {}, parties: {}, instances: {}, receipts: {} };
  const command = body => { if (typeof body.commandId !== 'string' || !body.commandId.length || body.commandId.length > 128) throw fail('COMMAND_ID_REQUIRED', 'commandId required'); };
  function status() { return { version: data.version, count: places.size, worldRevision: state.revision, source: data.source ?? null, routeTtlMs, hardwareAttested: false }; }
  function restore(saved) { if (saved) state = clone(saved); events.restore(saved?.eventLedger,saved?.instances); delete state.eventLedger; }
  function durable() { return {...clone(state),eventLedger:events.durable()}; }
  function review(body) {
    command(body); const p = places.get(body.placeId); if (!p) throw fail('PLACE_NOT_FOUND', 'Known catalog place required', 404);
    if (body.expectedRevision !== state.revision) throw fail('WORLD_REVISION_CONFLICT', 'Refresh world revision', 409);
    if (!['VERIFIED','REJECTED','UNKNOWN'].includes(body.accessStatus) || typeof body.enabled !== 'boolean') throw fail('INVALID_REVIEW', 'accessStatus and enabled required');
    let entrance = null, playZone = null;
    if (body.accessStatus === 'VERIFIED') {
      entrance = coordinate(body.entrance); playZone = { ...coordinate(body.playZone), radiusM: body.playZone.radiusM };
      if (!finite(playZone.radiusM) || playZone.radiusM < 10 || playZone.radiusM > 200 || body.parkingAllowed !== true || body.dwellAllowed !== true || typeof body.evidence !== 'string' || body.evidence.length < 5 || body.evidence.length > 1000) throw fail('INVALID_REVIEW', 'Verified entrance, play zone, parking/dwell and evidence required');
      if (distanceMeters(entrance, playZone) > 500 || distanceMeters(p, entrance) > 2000) throw fail('INVALID_REVIEW', 'Review geometry too far from place');
    } else if (body.enabled) throw fail('INVALID_REVIEW', 'Only verified places may be enabled');
    state.reviews[p.placeId] = { accessStatus: body.accessStatus, enabled: body.enabled, entrance, playZone, parkingAllowed: body.parkingAllowed === true, dwellAllowed: body.dwellAllowed === true, evidence: body.evidence ?? '', reviewedAt: clock() };
    state.revision++; return { revision: state.revision, place: project(p) };
  }
  function project(p) {
    const review = state.reviews[p.placeId] ?? { accessStatus: 'UNKNOWN', enabled: false, entrance: null, playZone: null, parkingAllowed: false, dwellAllowed: false, reviewedAt: null };
    const { evidence, ...publicReview } = review;
    return { ...p, ...publicReview, dataVersion: data.version };
  }
  function eligible(p) { return p.enabled && p.accessStatus === 'VERIFIED' && p.parkingAllowed && p.dwellAllowed; }
  function nearby(body) {
    const center = coordinate(body), radiusM = body.radiusM ?? 2000;
    if (!finite(radiusM) || radiusM < 1 || radiusM > 10000) throw fail('INVALID_RADIUS', 'radiusM 1..10000');
    const limit = body.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || body.category && !['ATTRACTION','PARKING','CHARGER','FUEL_STATION'].includes(body.category)) throw fail('INVALID_FILTER', 'Valid category and limit 1..100');
    const candidates = [];
    for (const raw of places.values()) {
      if (body.category && raw.category !== body.category) continue;
      const distanceM = distanceMeters(center, raw); if (distanceM > radiusM) continue;
      const p = project(raw); if (body.eligibleOnly !== false && !eligible(p)) continue;
      candidates.push({ ...p, distanceM: Math.round(distanceM), distanceBasis: 'STRAIGHT_LINE_NOT_ROAD_ACCESS' });
    }
    candidates.sort((a,b) => a.distanceM - b.distanceM || a.placeId.localeCompare(b.placeId));
    return { ...status(), worldRevision: state.revision, places: candidates.slice(0,limit), truncated: candidates.length > limit };
  }
  function setRoute(roomId, body) {
    command(body); const old = routes.get(roomId); const revision = old?.revision ?? 0;
    if (body.expectedRouteRevision !== revision) throw fail('ROUTE_REVISION_CONFLICT', 'Refresh route revision', 409);
    if (body.source === 'NONE') { routes.set(roomId, { revision: revision + 1, expiresAt: 0, geometry: [] }); return routeInfo(roomId); }
    if (!['PLEOS_ROUTE','EXTERNAL_ROUTING','DEMO_ROUTE'].includes(body.source) || !Array.isArray(body.geometry) || body.geometry.length < 2 || body.geometry.length > 128) throw fail('INVALID_ROUTE', 'Explicit source and 2..128 WGS84 points required');
    const geometry = body.geometry.map(coordinate); let lengthM = 0;
    for (let i = 1; i < geometry.length; i++) { const d = distanceMeters(geometry[i-1], geometry[i]); if (d > 20000) throw fail('ROUTE_TOO_SPARSE', 'Maximum segment length 20km'); lengthM += d; }
    if (lengthM < 1 || lengthM > 500000) throw fail('INVALID_ROUTE', 'Route length 1m..500km');
    routes.set(roomId, { revision: revision+1, source: body.source, geometry, lengthM: Math.round(lengthM), expiresAt: clock()+routeTtlMs }); return routeInfo(roomId);
  }
  function routeInfo(roomId) { const r = routes.get(roomId); return { routeRevision: r?.revision ?? 0, active: !!r && r.expiresAt > clock(), source: r?.source ?? 'NONE', lengthM: r?.lengthM ?? 0, expiresAt: r?.expiresAt ?? null }; }
  function routeSpots(roomId, body) {
    const r = routes.get(roomId); if (!r || r.expiresAt <= clock()) throw fail('ROUTE_REQUIRED', 'Submit a fresh route', 409);
    if (body.routeRevision !== r.revision) throw fail('ROUTE_REVISION_CONFLICT', 'Use latest route revision', 409);
    const corridorM = body.corridorM ?? 500; if (!finite(corridorM) || corridorM < 10 || corridorM > 2000) throw fail('INVALID_CORRIDOR', 'corridorM 10..2000');
    const latitudes = r.geometry.map(p=>p.latitude), longitudes = r.geometry.map(p=>p.longitude), pad = corridorM / 110000;
    const minLat = Math.min(...latitudes)-pad, maxLat = Math.max(...latitudes)+pad;
    const lonPad = pad / Math.max(.01, Math.cos(Math.max(Math.abs(minLat),Math.abs(maxLat))*Math.PI/180));
    const minLon = Math.min(...longitudes)-lonPad, maxLon = Math.max(...longitudes)+lonPad;
    const candidates = [];
    for (const raw of places.values()) {
      const p = project(raw); if (!eligible(p)) continue;
      const e = p.entrance; if (e.latitude < minLat || e.latitude > maxLat || e.longitude < minLon || e.longitude > maxLon) continue;
      const routeDistanceM = distanceToRoute(e,r.geometry); if (routeDistanceM > corridorM) continue;
      candidates.push({ ...p, routeDistanceM: Math.round(routeDistanceM), detourTimeSec: null, roadAccess: 'DETOUR_UNKNOWN', eligibilityReasons: ['REVIEW_VERIFIED','CORRIDOR_MATCH','ROAD_DETOUR_NOT_VERIFIED'] });
    }
    candidates.sort((a,b)=>a.routeDistanceM-b.routeDistanceM || a.placeId.localeCompare(b.placeId));
    return { ...routeInfo(roomId), dataVersion: data.version, policyVersion: 'reviewed-corridor-v1', worldRevision: state.revision, places: candidates.slice(0,100), truncated: candidates.length>100 };
  }
  function arrivedCharger(position) {
    if (!position) return null;
    for (const [placeId, review] of Object.entries(state.reviews)) {
      const place = places.get(placeId);
      if (place?.category === 'CHARGER' && eligible(review) &&
          distanceMeters(position, review.playZone) <= review.playZone.radiusM)
        return { placeId, name: place.name, latitude: review.playZone.latitude, longitude: review.playZone.longitude };
    }
    return null;
  }
  function routeSupplySpot(roomId, position, claimed, nativeGuidance = false) {
    const route = routes.get(roomId);
    if (!nativeGuidance && (!route || route.expiresAt <= clock())) return null;
    let nearest = null, closest = 180;
    for (const place of places.values()) {
      if (!['CHARGER','FUEL_STATION','PARKING'].includes(place.category) || claimed(place.placeId)) continue;
      const review = state.reviews[place.placeId];
      if (review?.accessStatus === 'REJECTED') continue;
      const point = review?.entrance ?? place.navigationDestination;
      if (!point || (!review?.entrance && place.drivingAssessment?.networkRoundTrip !== true)) continue;
      const distance = distanceMeters(position, point);
      if (distance > closest || (!nativeGuidance && distanceToRoute(point, route.geometry) > 120)) continue;
      nearest = { placeId: place.placeId, name: place.name, category: place.category,
        latitude: point.latitude, longitude: point.longitude };
      closest = distance;
    }
    return nearest;
  }
  function setParty(roomId, body) {
    command(body); if (typeof body.visible !== 'boolean' || typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 24) throw fail('INVALID_PARTY', 'visible and name 1..24 required');
    if (body.spotId != null) { const raw = places.get(body.spotId); if (!raw || !eligible(project(raw))) throw fail('SPOT_NOT_ELIGIBLE','Select verified enabled spot',409); }
    state.parties[roomId] = { visible: body.visible, name: body.name, spotId: body.spotId ?? null }; state.revision++; return { partyId: roomId, ...state.parties[roomId], worldRevision: state.revision };
  }
  function shared(spotId, rooms) {
    const p = places.get(spotId); if (!p || !eligible(project(p))) throw fail('SPOT_NOT_ELIGIBLE','Verified enabled spot required',409);
    const parties = [];
    for (const room of rooms) { const s = state.parties[room.roomId]; if (!s?.visible || s.spotId !== spotId || room.closedAt || !room.vehicle.hostConnected || clock()-room.vehicle.receivedAt > 6000) continue;
      parties.push({ partyId: room.roomId, name: s.name, members: [...room.members.values()].filter(m=>m.approved).length, phase: room.state }); }
    return { worldRevision: state.revision, spot: project(p), parties: parties.slice(0,100), instance: events.current(spotId), eventPolicy:events.policy(), eventRevision:events.revision(), serverTime: clock() };
  }
  function checkedEventSpot(spotId) {
    const p=places.get(spotId);if(!p||!eligible(project(p)))throw fail('SPOT_NOT_ELIGIBLE','Verified enabled spot required',409);
  }
  function joinEvent(room, body) {
    checkedEventSpot(body.spotId);
    if(!state.parties[room.roomId]?.visible||state.parties[room.roomId]?.spotId!==body.spotId)throw fail('CONTRIBUTION_NOT_READY','Select and publish this spot first',409);
    return events.join(room,body);
  }
  function contribute(room, body, gateAllowed) {
    checkedEventSpot(body.spotId);
    if(!state.parties[room.roomId]?.visible||state.parties[room.roomId]?.spotId!==body.spotId)throw fail('CONTRIBUTION_NOT_READY','Public selected spot required',409);
    // Preserve historical successful v7/v8 receipts, but never grant new legacy contributions.
    const old=state.receipts[room.roomId+':'+body.commandId];
    if(old){const fingerprint=createHash('sha256').update(JSON.stringify({spotId:body.spotId,commandId:body.commandId,expectedInstanceRevision:body.expectedInstanceRevision})).digest('hex');if(old.fingerprint!==fingerprint||body.instanceId!==undefined)throw fail('IDEMPOTENCY_CONFLICT','Command changed',409);return {...clone(old.response),replayed:true};}
    return events.contribute(room,body,gateAllowed);
  }
  function closeParty(roomId) { delete state.parties[roomId]; routes.delete(roomId); state.revision++; }
  return { status, restore, durable, review, nearby, setRoute, routeInfo, routeSpots, routeSupplySpot, arrivedCharger, setParty, shared, contribute, closeParty, inviteIds, events, joinEvent, partySpot:id=>state.parties[id]?.spotId??null, partyName:id=>state.parties[id]?.name??'차량 파티' };
}
