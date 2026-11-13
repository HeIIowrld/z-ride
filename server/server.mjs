import { Game as ElectricThief } from './venue-electric-thief.mjs';
import { Game as ChargeRelay } from './venue-charge-relay.mjs';
import http from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { createWorldService } from './world.mjs';
import { createStateStore, STATE_FORMAT_VERSION } from './state-store.mjs';
import { createObserverService } from './observer.mjs';
import { createPhoneClientService } from './phone-client.mjs';
import { createEffectsService } from './effects.mjs';
import { createGameStateService } from './game-state.mjs';
import { createCabinService } from './cabin.mjs';
import { createPlacesService } from './places.mjs';
import {navigationReport,navigationSnapshot} from './navigation.mjs';
import { createPartyApi } from './party-api.mjs';
import { createAccounts } from './accounts.mjs';
import { createAccountApi } from './account-api.mjs';
import { createRequestPolicy, deploymentOptions } from './request-policy.mjs';
import { resolve } from 'node:path';

export const SECTORS = Object.freeze(Object.assign(Object.create(null), {
  FRONT_PASSENGER: [-45, 90], REAR_LEFT: [-180, -45], REAR_RIGHT: [45, 180],
}));
const passengerSeat = value => typeof value === 'string' && Object.hasOwn(SECTORS, value);
const SEATS = ['DRIVER', ...Object.keys(SECTORS)];
const OCCUPANCY = ['OCCUPIED', 'EMPTY', 'UNKNOWN'];
const UX = ['ALLOWED', 'RESTRICTED', 'UNKNOWN'];
const GEARS = ['P', 'R', 'N', 'D', 'UNKNOWN'];
const BODY_LIMIT = 16 * 1024;
const token = () => randomBytes(24).toString('base64url');
const newZombies = () => [
  { id: 'zombie_left', angleDeg: -100, hp: 5, maxHp: 5 },
  { id: 'zombie_front', angleDeg: 60, hp: 5, maxHp: 5 },
  { id: 'zombie_rear', angleDeg: 140, hp: 5, maxHp: 5 },
];
const PICKUPS = Object.freeze([
  { pickupId: 'DEMO_PICKUP_A', title: '테스트 보급 상자 A', resource: 'supplies', amount: 1 },
  { pickupId: 'DEMO_PICKUP_B', title: '테스트 보급 상자 B', resource: 'supplies', amount: 1 },
  { pickupId: 'DEMO_PICKUP_C', title: '테스트 보급 상자 C', resource: 'supplies', amount: 1 },
]);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const angularDistance = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const asText = (value, max = 128) => typeof value === 'string' && value.length > 0 && value.length <= max;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function createDemoServer(options = {}) {
  const driveGames = new Set(['license-quiz', 'pole-jump', 'raindrop']);
  const phoneClient = createPhoneClientService({apiOrigin:options.browserApiOrigin??'',displayName:options.displayName??'PLY'});
  const requestPolicy=createRequestPolicy(options);
  const testAccessKey = options.testAccessKey ?? '';
  if (typeof testAccessKey !== 'string' || testAccessKey.length > 1024) throw new Error('testAccessKey must be a string up to 1024 characters');
  const testAccessDigest = testAccessKey ? createHash('sha256').update(testAccessKey).digest() : null;
  const leaseMs = options.leaseMs ?? 6000;
  const pairingTtlMs = options.pairingTtlMs ?? 120000;
  const maxReceipts = options.maxReceiptsPerMember ?? 10000;
  const world = createWorldService({ clock: options.worldClock ?? Date.now, maxReceipts, respawnMs:options.pickupRespawnMs??300000 });
  const deadzoneOrigin = options.deadzoneOrigin ? new URL(options.deadzoneOrigin).origin : null;
  const deadzonePending = new Set();
  const supplyChallenges = new WeakMap();
  const venueGames = new WeakMap();
  function deadzoneScope(room) {
    return JSON.stringify([places.partySpot(room.roomId), room.game.missionRunId]);
  }
  function linkedDeadzone(room) {
    const match = room.deadzoneMatch;
    return match?.scope === deadzoneScope(room) ? match : null;
  }
  const effects = createEffectsService({ clock: options.effectsClock ?? Date.now });
  const gameState = createGameStateService({ clock: options.gameClock ?? Date.now });
  const cabin = createCabinService({ clock: options.cabinClock ?? Date.now });
  const places = createPlacesService({ catalogPath: options.placesPath, catalog: options.placesCatalog, clock:options.eventClock??Date.now, eventPolicy:options.eventPolicy });
  let publicOrigin = options.publicOrigin ?? '';
  if (publicOrigin) { const url = new URL(publicOrigin); if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('publicOrigin must be a plain HTTP(S) origin'); publicOrigin = url.origin; }
  const accounts=createAccounts({clock:options.accountClock??Date.now,googleClientId:options.googleClientId??'',publicOrigin,verifyGoogleIdToken:options.verifyGoogleIdToken});
  const autoEffects = new Map();
  const sessions = new Map();
  const rooms = new Map();
  const joinCodes = new Map();
  const sockets = new Set();
  const requestBuckets = new Map();
  let listening = false;
  let closing = false;
  let storageFailed = false;
  let transaction = null;
  const storage = options.stateStore ?? (options.dbPath ? createStateStore(options.dbPath) : null);
  const findSession = credential => typeof credential === 'string' ? sessions.get(createHash('sha256').update(credential).digest('hex')) : undefined;

  function durableState() {
    return {
      formatVersion: STATE_FORMAT_VERSION, places: places.durable(),accounts:accounts.durable(),
      sessions: [...sessions.entries()].map(([key, s]) => [key, {
        sessionId: s.sessionId, role: s.role, nickname: s.nickname, expiresAt: s.expiresAt, roomId: s.roomId,accountUserId:s.accountUserId,
      }]),
      rooms: [...rooms.values()].map(room => ({
        roomId: room.roomId, roomEpoch: room.roomEpoch, stateVersion: room.stateVersion,
        state: room.state, pauseReason: room.pauseReason, joinCode: room.joinCode,
        joinExpiresAt: room.joinExpiresAt, joinUsed: room.joinUsed,
        emptyLocks: [...room.emptyLocks], stats: room.stats, zombies: room.zombies,
        collection: room.collection, deadzoneMatch: room.deadzoneMatch, driveGame: room.driveGame, game: gameState.durable(room.game), closedAt: room.closedAt ?? null,
        partyWorldClaims:[...(room.partyWorldClaims??[])],partyPickupClaims:[...(room.partyPickupClaims??[])],collectionRevision:room.collectionRevision??0,
        partyPickupRespawns:[...(room.partyPickupRespawns??[])],
        departedMembers: [...(room.departedMembers ?? new Map()).values()].map(m => ({ ...m, socket: undefined, receipts: [...m.receipts], collectedPickups: [...(m.collectedPickups??[])], worldClaims: [...(m.worldClaims??[])], worldReceipts: [...(m.worldReceipts??[])], gameReceipts: [...(m.gameReceipts??[])] })),
        members: [...room.members.values()].map(m => ({
          memberId: m.memberId, sessionId: m.sessionId, nickname: m.nickname, role: m.role,
          seat: m.seat, approved: m.approved, accountUserId:m.accountUserId,accountMembershipId:m.accountMembershipId, receipts: [...m.receipts],
          collectedPickups: [...(m.collectedPickups ?? [])],
          worldClaims: [...(m.worldClaims ?? [])], worldReceipts: [...(m.worldReceipts ?? [])],
          gameReceipts: [...(m.gameReceipts ?? [])],
        })),
      })),
    };
  }
  function restoreState(saved) {
    if (!saved || ![1, STATE_FORMAT_VERSION].includes(saved.formatVersion) || !Array.isArray(saved.sessions) || !Array.isArray(saved.rooms)) throw new Error('Invalid persisted server state');
    places.restore(saved.places);accounts.restore(saved.accounts);
    for (const [key, session] of saved.sessions) sessions.set(key, session);
    for (const savedRoom of saved.rooms) {
      const room = {
        ...savedRoom, game: gameState.restore(savedRoom.game), emptyLocks: new Set(savedRoom.emptyLocks),
        departedMembers: new Map((savedRoom.departedMembers??[]).map(m=>[m.sessionId,{...m,socket:null,receipts:new Map(m.receipts),collectedPickups:new Set(m.collectedPickups),worldClaims:new Map(m.worldClaims),worldReceipts:new Map(m.worldReceipts),gameReceipts:new Map(m.gameReceipts)}])),
        members: new Map(savedRoom.members.map(m => [m.sessionId, {
          ...m, socket: null, receipts: new Map(m.receipts), collectedPickups: new Set(m.collectedPickups),
          worldClaims: new Map(m.worldClaims), worldReceipts: new Map(m.worldReceipts),
          gameReceipts: new Map(m.gameReceipts ?? []),
        }])),
        vehicle: { ux: 'UNKNOWN', gear: 'UNKNOWN', foreground: false, seats: [],
          charge: { state: 'UNKNOWN', portConnection: 'UNKNOWN', source: 'NONE' },
          source: 'SERVER_RESTART', receivedAt: 0, hostConnected: false },
      };
      const historicMembers=[...room.members.values(),...room.departedMembers.values()];
      room.partyWorldClaims=new Map(savedRoom.partyWorldClaims??historicMembers.flatMap(m=>[...m.worldClaims]));
      room.partyPickupClaims=new Set(savedRoom.partyPickupClaims??historicMembers.flatMap(m=>[...m.collectedPickups]));
      room.partyPickupRespawns=new Map(savedRoom.partyPickupRespawns??[...room.partyPickupClaims].map(id=>[id,{at:world.now(),claimId:randomUUID(),respawnAt:world.now()+world.respawnMs,respawnNotified:false}]));
      room.collectionRevision=savedRoom.collectionRevision??0;
      // Never restore a live vehicle lease or an active combat/temporary support effect.
      if (room.state === 'PLAYING') { room.state = 'PAUSED'; room.roomEpoch++; }
      if (room.state === 'PAUSED' || room.state === 'READY') room.pauseReason = 'SERVER_RESTART';
      room.stats.supportUntil = 0;
      room.stateVersion++;
      rooms.set(room.roomId, room);
      places.events.restoreRoom(room);
      if (!room.joinUsed && room.joinExpiresAt > Date.now()) joinCodes.set(room.joinCode, room.roomId);
    }
  }
  function unavailable() { return fail('STORAGE_UNAVAILABLE', 'Durable state is unavailable; restart after restoring database access', 503); }
  function atomic(action) {
    if (storageFailed) throw unavailable();
    if (transaction) return action();
    const pending = { effects: [], broadcasts: new Set() };
    transaction = pending;
    let value;
    try {
      value = action();
      if (storage) {
        try { storage.save(durableState()); }
        catch {
          storageFailed = true;
          for (const room of rooms.values()) {
            room.vehicle.hostConnected = false; room.vehicle.receivedAt = 0;
            room.vehicle.foreground = false; room.vehicle.ux = 'UNKNOWN'; room.vehicle.gear = 'UNKNOWN';
          }
          for (const ws of sockets) ws.terminate();
          throw unavailable();
        }
      }
    } finally { transaction = null; }
    // Persistence succeeded before any acknowledgement or public state update.
    for (const effect of pending.effects) effect();
    for (const room of pending.broadcasts) broadcast(room);
    return value;
  }
  try {
    const saved = storage?.load();
    if (saved) { restoreState(saved); storage.save(durableState()); }
  } catch (error) { storage?.close(); throw error; }
  const observers = createObserverService({
    getSession: credential => storageFailed ? undefined : findSession(credential),
    getRoom: id => storageFailed ? undefined : rooms.get(id),
    getRooms: () => storageFailed ? [] : rooms.values(),
    getGate: room => storageFailed ? { allowed: false, reasons: ['STORAGE_UNAVAILABLE'] } : gate(room),
    getEffects: room => storageFailed ? null : effects.snapshot(room.roomId),
    getGame: room => storageFailed ? null : gameState.snapshot(room.game, { ...gameContext(room), role: 'OBSERVER' }),
    getCabin: room => storageFailed ? null : cabin.snapshot(cabinContext(room)),
    operatorToken: options.observerToken ?? '',
    allowedOrigins: options.observerAllowedOrigins ?? [],
  });

  function authenticate(req) {
    const value = req.headers.authorization;
    if (!value?.startsWith('Bearer ')) throw fail('AUTH_REQUIRED', 'Bearer token required', 401);
    const session = findSession(value.slice(7));
    if (!session || session.expiresAt <= Date.now()) throw fail('AUTH_EXPIRED', 'Session missing or expired', 401);
    return session;
  }
  function memberFor(room, session, approved = true) {
    if (room.closedAt) throw fail('PARTY_CLOSED', 'Party was disbanded', 409);
    const member = room.members.get(session.sessionId);
    if (!member) throw fail('NOT_MEMBER', 'Not a member of this room', 403);
    if (approved && !member.approved) throw fail('MEMBER_PENDING', 'Waiting for vehicle approval', 403);
    return member;
  }
  function roomFor(id) {
    const room = rooms.get(id);
    if (!room) throw fail('ROOM_NOT_FOUND', 'Room not found', 404);
    return room;
  }
  function requireHost(room, session) {
    const member = memberFor(room, session);
    if (member.role !== 'CAR_HOST') throw fail('ROLE_FORBIDDEN', 'Vehicle host only', 403);
    return member;
  }
  function seatEvidence(room, seat) {
    if (room.emptyLocks.has(seat)) return 'EMPTY';
    const occupancy = room.vehicle.seats.find(s => s.seat === seat)?.occupancy ?? 'UNKNOWN';
    return occupancy === 'OCCUPIED' ? 'SENSOR' : occupancy === 'EMPTY' ? 'EMPTY' : 'MANUAL_UNKNOWN';
  }
  function gate(room) {
    const v = room.vehicle;
    const reasons = [];
    if (room.closedAt) reasons.push('PARTY_DISBANDED');
    if (!v.hostConnected) reasons.push('CAR_DISCONNECTED');
    if (!v.foreground) reasons.push('APP_INACTIVE');
    if (Date.now() - v.receivedAt > leaseMs) reasons.push('LEASE_EXPIRED');
    if (v.ux !== 'ALLOWED') reasons.push(v.ux === 'RESTRICTED' ? 'UX_RESTRICTED' : 'UX_UNKNOWN');
    if (v.gear !== 'P') reasons.push(v.gear === 'UNKNOWN' ? 'GEAR_UNKNOWN' : 'GEAR_NOT_P');
    return { allowed: reasons.length === 0, reasons };
  }
  function venueStop(room) {
    const charge = room.vehicle.charge;
    if (!gate(room).allowed || charge.state !== 'CHARGING' || charge.portConnection !== 'CONNECTED') return null;
    return places.arrivedCharger(navigationSnapshot(room).position);
  }

  function routeSupplyContext(room) {
    const now = Date.now();
    if (room.vehicle.gear !== 'D' || !room.vehicle.receivedAt ||
        now - room.vehicle.receivedAt > leaseMs) return null;
    const nav = navigationSnapshot(room, now);
    if (!nav.position) return null;
    if (nav.status === 'ROUTE_DRIVE') {
      return { key: 'native:' + nav.nativeRouteRevision, position: nav.position, native: true };
    }
    if (nav.owned) return null;
    const route = places.routeInfo(room.roomId);
    return route.active ? { key: 'external:' + route.routeRevision, position: nav.position, native: false } : null;
  }

  function availableRouteSupply(room, context, member) {
    return context && places.routeSupplySpot(room.roomId, context.position,
      id => Object.hasOwn(room.collection.routeClaims ?? {}, id) ||
        room.collection.routeAttempts?.[member.memberId]?.includes(id), context.native);
  }

  function routeSupplyView(room, viewer) {
    const spot = viewer.approved && passengerSeat(viewer.seat) && seatEvidence(room, viewer.seat) !== 'EMPTY'
      ? availableRouteSupply(room, routeSupplyContext(room), viewer) : null;
    return {
      routeSupplyAvailable: Boolean(spot),
      routeSupplySpot: spot ? { placeId: spot.placeId, name: spot.name, latitude: spot.latitude, longitude: spot.longitude } : null,
    };
  }

  function venueView(room, member) {
    const session = venueGames.get(room);
    const stop = venueStop(room);
    if (!session) return { stop, game: null };
    if (session.stop.placeId !== stop?.placeId) return { stop, game: null, paused: true };
    const { engine, kind, itemUsed } = session;
    const state = engine.players.some(player => player.id === member.memberId) && member.role !== 'CAR_HOST'
      ? engine.playerView(member.memberId) : engine.publicView();
    return { stop, kind, game: state, supplies: room.collection.inventory.supplies,
      canUseItem: itemUsed !== (kind === 'thief' ? engine.caseNo : engine.round) &&
        (kind === 'thief' ? engine.phase === 'RESULT' && engine.result?.success === false && !engine.result.saved : engine.phase === 'PLAY') };
  }

  function updateVenue(room) {
    const session = venueGames.get(room);
    if (!session || session.engine.phase === 'END') return;
    const now = Date.now();
    if (venueStop(room)?.placeId !== session.stop.placeId) {
      session.pausedAt ??= now;
      return;
    }
    const { engine } = session;
    if (session.pausedAt && engine.deadline) engine.deadline += now - session.pausedAt;
    session.pausedAt = null;
    if (session.kind === 'thief' && Number.isFinite(room.vehicle.charge.socPercent))
      engine.setSoc(room.vehicle.charge.socPercent, 'CAR');
    if (engine.deadline && engine.deadline <= now) {
      if (session.kind === 'thief') engine.next();
      else if (engine.phase === 'PLAY') engine.expire();
    }
  }

  function handleVenue(room, session, body) {
    const member = memberFor(room, session);
    const action = body.action;
    if (action === 'status') return venueView(room, member);
    const host = member.role === 'CAR_HOST';
    const stop = venueStop(room);
    if (!stop) throw fail('CHARGING_STOP_REQUIRED', 'Park and charge at an approved stop', 409);
    let current = venueGames.get(room);
    if (action === 'open') {
      requireHost(room, session);
      if (current && current.engine.phase !== 'END') return venueView(room, member);
      if (linkedDeadzone(room)?.state === 'playing')
        throw fail('GAME_ALREADY_ACTIVE', 'Finish DEADZONE before starting another game', 409);
      if (!['thief', 'relay'].includes(body.kind)) throw fail('UNKNOWN_GAME', 'Choose a charging game');
      const roster = [...room.members.values()].filter(p => p.approved && p.socket &&
        passengerSeat(p.seat) && seatEvidence(room, p.seat) !== 'EMPTY');
      if (roster.length < 2) throw fail('NEED_PLAYERS', 'At least two approved connected passengers required', 409);
      const engine = body.kind === 'thief' ? new ElectricThief() : new ChargeRelay();
      for (const rider of roster) {
        engine.addPlayer(rider.memberId, rider.nickname);
        engine.setConnected(rider.memberId, true);
      }
      if (body.kind === 'thief') {
        if (!Number.isFinite(room.vehicle.charge.socPercent)) throw fail('SOC_REQUIRED', 'Vehicle battery unavailable', 409);
        engine.setSoc(room.vehicle.charge.socPercent, 'CAR');
        if (engine.soc > 95) throw fail('BATTERY_FULL', 'Battery needs room for another 5 percent', 409);
      }
      current = { stop, kind: body.kind, engine, itemUsed: -1 };
      venueGames.set(room, current);
      return venueView(room, member);
    }
    if (!current || current.stop.placeId !== stop.placeId)
      throw fail('NO_VENUE_GAME', 'No charging game at this stop', 409);
    const { engine, kind } = current;
    if (!host && (!engine.players.some(player => player.id === member.memberId) || seatEvidence(room, member.seat) === 'EMPTY'))
      throw fail('ROLE_FORBIDDEN', 'This seat is not in the game', 403);
    updateVenue(room);
    try {
      if (host && action === 'start') engine.start(kind === 'relay' ? 2 : undefined);
      else if (host && action === 'next' && engine.phase !== 'END') engine.next();
      else if (host && action === 'item') {
        if (!venueView(room, member).canUseItem) throw new Error('ITEM_NOT_READY');
        if (room.collection.inventory.supplies < 1) throw new Error('SUPPLY_REQUIRED');
        if (kind === 'thief') {
          engine.blackouts = Math.max(0, engine.blackouts - 1);
          engine.result = { ...engine.result, saved: true };
          engine.cabin = { light: 'NORMAL', air: 'NORMAL' };
        } else engine.deadline += 15000;
        current.itemUsed = kind === 'thief' ? engine.caseNo : engine.round;
        room.collection.inventory.supplies--;
        collectionChanged(room);
      } else if (!host && kind === 'thief' && action === 'ready') engine.confirm(member.memberId);
      else if (!host && kind === 'thief' && action === 'play') engine.play(member.memberId, body);
      else if (!host && kind === 'thief' && action === 'vote') engine.vote(member.memberId, body.suspect);
      else if (!host && kind === 'relay' && action === 'submit') engine.submit(member.memberId, body);
      else throw new Error('INVALID_VENUE_ACTION');
    } catch (error) {
      if (/^[A-Z_]+$/.test(error.message)) throw fail(error.message, 'Action unavailable in the current game phase', 409);
      throw error;
    }
    return venueView(room, member);
  }

  function effectHost(room) { return [...room.members.values()].find(member => member.role === 'CAR_HOST'); }
  function effectContext(room, actor = effectHost(room), deadzonePlaying = false) {
    const host = effectHost(room); const socket = host?.socket;
    const live = socket?.readyState === WebSocket.OPEN && socket.effectExpiresAt > Date.now();
    const g = gate(room);
    const match = linkedDeadzone(room);
    const deadzoneScene = match && effects.snapshot(room.roomId).sceneId === 'deadzone-' + match.code;
    return { roomId: room.roomId, roomEpoch: room.roomEpoch,
      state: deadzonePlaying || (deadzoneScene && match.state === 'playing') ? 'PLAYING' : room.state,
      role: actor?.role, connectionId: live ? socket.effectConnectionId : null,
      gate: live ? g : { allowed: false, reasons: [...g.reasons, 'CAR_DISCONNECTED'] } };
  }
  function queueEffectEvents(room, outcome, target = effectHost(room)?.socket) {
    if (target) for (const event of outcome.events ?? []) send(target, event);
  }
  function applyEffects(room, outcome) {
    queueEffectEvents(room, outcome);
    if (outcome.changed) change(room);
    return { effects: effects.snapshot(room.roomId), data: outcome.data, replayed: outcome.replayed === true };
  }
  function visibleMembers(room, viewer) {
    return [...room.members.values()].filter(member => !viewer || viewer.role === 'CAR_HOST' || member.approved);
  }
  function gameContext(room, actor = effectHost(room)) {
    return { ...effectContext(room, actor), memberId: actor?.memberId,
      inventorySupplies: room.collection.inventory.supplies, waveCleared: room.stats.waveCleared,
      members: visibleMembers(room, actor).map(member => ({ memberId: member.memberId, role: member.role,
        seat: member.seat, approved: member.approved, connected: member.socket?.readyState === WebSocket.OPEN })) };
  }
  function cabinContext(room, viewer = effectHost(room)) {
    const fx = effects.snapshot(room.roomId);
    return { ...effectContext(room, viewer), members: visibleMembers(room, viewer).map(member => ({
      memberId: member.memberId, seat: member.seat, approved: member.approved, seatEvidence: seatEvidence(room, member.seat),
    })), airflowControlled: fx.enabled && fx.channels.includes('AIRFLOW') };
  }
  function resetCombat(room) {
    room.zombies = newZombies();
    Object.assign(room.stats, { shots: 0, rejectedShots: 0, hits: 0, kills: 0, waveCleared: false,
      zombieHp: 5, lastShot: null, supportUntil: 0, supportCount: 0, supportSupplyUsed: false });
  }
  function syncGameEffects(room) {
    const fx = effects.snapshot(room.roomId), ctx = effectContext(room);
    if (room.game.scenarioId !== 'heist-demo-v1' || !fx.enabled || room.state !== 'PLAYING' || !ctx.gate.allowed) { autoEffects.delete(room.roomId); return; }
    const at = (options.effectsClock ?? Date.now)();
    const previous = autoEffects.get(room.roomId);
    const sceneId = `${room.game.missionRunId}:${room.game.stageId}`;
    if (previous && previous.effectSessionId === fx.effectSessionId && previous.sceneId === sceneId && at - previous.at < 2000) return;
    try {
      const outcome = effects.scene(ctx, { commandId: 'game-' + randomUUID(), effectSessionId: fx.effectSessionId,
        sceneId, virtualSpeedMps: room.game.virtualSpeedMps });
      queueEffectEvents(room, outcome);
      autoEffects.set(room.roomId, { at, effectSessionId: fx.effectSessionId, sceneId });
    } catch { queueEffectEvents(room, effects.stop(ctx, 'GAME_EFFECT_SYNC_FAILED')); autoEffects.delete(room.roomId); }
  }
  function snapshot(room, viewer) {
    if (!viewer.approved) {
      return {
        roomId: room.roomId, roomEpoch: room.roomEpoch, stateVersion: room.stateVersion, state: 'PENDING', pauseReason: 'MEMBER_PENDING', joinCode: null, joinExpiresAt: 0,
        members: [{ memberId: viewer.memberId, sessionId: viewer.sessionId, nickname: viewer.nickname, role: viewer.role, seat: viewer.seat, approved: false, connected: !!viewer.socket, seatEvidence: 'MANUAL_UNKNOWN', sector: SECTORS[viewer.seat] }],
        vehicle: { ux: 'UNKNOWN', gear: 'UNKNOWN', foreground: false, seats: [], charge: { state: 'UNKNOWN', portConnection: 'UNKNOWN', source: 'NONE' }, source: 'PENDING_REDACTED', reportAgeMs: null, playAllowed: false, gateReasons: ['MEMBER_PENDING'] },
        stats: { shots: 0, rejectedShots: 0, hits: 0, zombieHp: 0, zombieAngleDeg: 0, supportUntil: 0, supportCount: 0, supportDamage: 2, supportSupplyUsed: false, kills: 0, waveCleared: false, lastShot: null, supportActive: false },
        collection: { mode: 'DEMO_PICKUP', gpsVerified: false, label: '테스트 수집 지점 · GPS 미검증', fixtures: [], inventory: { supplies: 0 }, collectedPickupIds: [], lastCollect: null },
        zombies: [], sectors: SECTORS, trust: 'WAITING_FOR_VEHICLE_APPROVAL', serverTime: Date.now(),
      };
    }
    const host = viewer.role === 'CAR_HOST';
    const g = gate(room);
    return {
      roomId: room.roomId, roomEpoch: room.roomEpoch, stateVersion: room.stateVersion,
      state: room.state, pauseReason: room.pauseReason,
      joinCode: host && room.joinExpiresAt > Date.now() && !room.joinUsed ? room.joinCode : null,
      joinExpiresAt: room.joinExpiresAt,
      members: [...room.members.values()].filter(m => !viewer.approved ? m.sessionId === viewer.sessionId : host || m.approved).map(m => ({
        memberId: m.memberId, sessionId: m.sessionId, nickname: m.nickname, role: m.role,
        seat: m.seat, approved: m.approved, connected: !!m.socket,
        seatEvidence: seatEvidence(room, m.seat), sector: SECTORS[m.seat] ?? null,
      })),
      vehicle: {
        ux: room.vehicle.ux, gear: room.vehicle.gear, foreground: room.vehicle.foreground, seats: room.vehicle.seats,
        charge: room.vehicle.charge, source: room.vehicle.source,
        speedMps: room.vehicle.hostConnected && Date.now() - room.vehicle.receivedAt <= leaseMs
          ? room.vehicle.speedMps ?? null : null,
        reportAgeMs: room.vehicle.receivedAt ? Date.now() - room.vehicle.receivedAt : null,
        playAllowed: g.allowed, gateReasons: g.reasons,
      },
      stats: { ...room.stats, supportActive: room.stats.supportUntil > Date.now() },
      collection: {
        mode: 'DEMO_PICKUP', gpsVerified: false, label: '테스트 수집 지점 · GPS 미검증',
        fixtures: PICKUPS, inventory: { ...room.collection.inventory },
        collectedPickupIds: [...room.partyPickupClaims], lastCollect: room.collection.lastCollect,
        revision:room.collectionRevision,claimScope:'PARTY',
        respawnCooldownMs:world.respawnMs,pickupRespawnAt:Object.fromEntries([...room.partyPickupRespawns].filter(([,v])=>v.respawnAt>world.now()).map(([id,v])=>[id,v.respawnAt])),
        eligibility: viewer.role === 'CAR_HOST' ? 'DRIVER_CANNOT_COLLECT' : 'APPROVED_ROLE_AND_PASSENGER_SELF_DECLARATION_ONLY',
      },
      zombies: room.zombies.map(z => ({ ...z })),
      effects: effects.snapshot(room.roomId),
      ...(viewer.approved && !room.closedAt && linkedDeadzone(room)?.state !== 'ended' && linkedDeadzone(room) &&
          (!linkedDeadzone(room).partySeats || linkedDeadzone(room).partySeats[viewer.memberId]) ? {
        deadzoneJoinUrl: deadzoneOrigin + '/j/' + linkedDeadzone(room).code +
          (linkedDeadzone(room).partySeats ? '#party=' + linkedDeadzone(room).partySeats[viewer.memberId] : '')
      } : {}),
      game: gameState.snapshot(room.game, gameContext(room, viewer)),
      missionLedger:places.events.projection(room),
      cabin: cabin.snapshot(cabinContext(room, viewer)),
      party: { partyId: room.roomId, status: room.closedAt ? 'DISBANDED' : 'ACTIVE', route: places.routeInfo(room.roomId) },
      navigation: navigationSnapshot(room),
      ...(phoneClient.driveGamesAvailable && !room.closedAt
        ? { driveGamesAvailable: true, ...(room.driveGame ? { driveGame: room.driveGame } : {}) } : {}),
      ...routeSupplyView(room, viewer),
      sectors: SECTORS,
      trust: 'LOCAL_DEMO_CLIENT_REPORT_NOT_VEHICLE_ATTESTATION',
      serverTime: Date.now(),
    };
  }
  function send(ws, payload) {
    if (transaction) { transaction.effects.push(() => send(ws, payload)); return; }
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 128 * 1024) ws.send(JSON.stringify(payload));
  }
  function closeSocket(ws, code, reason) {
    if (transaction) { transaction.effects.push(() => closeSocket(ws, code, reason)); return; }
    ws.close(code, reason);
  }
  function broadcast(room) {
    if (transaction) { transaction.broadcasts.add(room); return; }
    if (storageFailed) return;
    for (const member of room.members.values()) {
      if (member.socket) send(member.socket, { type: 'snapshot', room: snapshot(room, member) });
    }
    observers.broadcast(room);
    notifyWorld();
  }
  function notifyWorld() {
    if (transaction) { transaction.effects.push(notifyWorld); return; }
    if (storageFailed) return;
    for (const ws of sockets) if (ws.worldSpotId && ws.worldSession?.expiresAt > Date.now()) {
      const room = rooms.get(ws.worldSession.roomId), member = room?.members.get(ws.worldSession.sessionId);
      if (!member?.approved || room.closedAt || member.socket !== ws) continue;
      try { const data=places.shared(ws.worldSpotId, rooms.values()), signature=hash({...data,serverTime:0});
        if (signature!==ws.worldSignature) { ws.worldSignature=signature;send(ws, {type:'world.snapshot', ...data}); }
      } catch { ws.worldSpotId = null; send(ws,{type:'world.unavailable'}); }
    }
  }
  function change(room) {
    const eventChanged=places.events.observe(room);
    if(eventChanged)for(const member of room.members.values())if(member.approved&&member.socket)send(member.socket,{type:'mission.changed',...places.events.projection(room),refreshResults:true,refreshRewards:true});
    room.stateVersion++;
    gameState.tick(room.game, gameContext(room));
    cabin.tick(cabinContext(room));
    queueEffectEvents(room, effects.tick(effectContext(room)));
    syncGameEffects(room);
    broadcast(room);
  }
  function collectionChanged(room) {
    room.collectionRevision++;
    change(room);
    for(const member of room.members.values())if(member.approved&&member.socket)send(member.socket,{type:'collection.changed',roomId:room.roomId,revision:room.collectionRevision,refreshNearby:true});
  }
  function pause(room, reason) {
    if (room.state === 'PLAYING') {
      room.state = 'PAUSED'; room.roomEpoch++; room.pauseReason = reason;
      change(room);
    }
  }
  async function readJson(req) {
    let size = 0; const chunks = [];
    // Preserve the HTTP socket on a bounded-body rejection so the error
    // response can be flushed, including with Connection: close.
    if (Number(req.headers['content-length']) > BODY_LIMIT) {
      req.on('error', () => {}); req.resume();
      throw fail('PAYLOAD_TOO_LARGE', 'Maximum 16 KiB', 413);
    }
    try {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > BODY_LIMIT) throw fail('PAYLOAD_TOO_LARGE', 'Maximum 16 KiB', 413);
        chunks.push(chunk);
      }
    } catch (error) {
      req.on('error', () => {}); req.resume(); throw error;
    }
    try {
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error();
      return result;
    } catch { throw fail('INVALID_JSON', 'JSON object required'); }
  }
  function result(res, status, value) {
    if (transaction) { transaction.effects.push(() => result(res, status, value)); return; }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(value));
  }
  function rateLimit(key, limit = 120) {
    const now = Date.now(); const item = requestBuckets.get(key);
    if (!item || item.until < now) { requestBuckets.set(key, { count: 1, until: now + 10000 }); return; }
    if (++item.count > limit) throw fail('RATE_LIMITED', 'Try again later', 429);
  }
  const partyApi = createPartyApi({ places, rooms, sessions, joinCodes, publicOrigin, accounts, authProviders:{describe:accounts.describe},
    phonePublicUrl:options.phonePublicUrl,
    reviewToken: options.placeReviewToken ?? '', roomFor, memberFor, requireHost, passengerSeat,
    snapshot, change, gate, closeSocket, pause, collectionChanged, notify: notifyWorld,
    eventChanged:instanceId=>{for(const room of rooms.values())if(!room.closedAt&&places.events.projection(room).instanceId===instanceId){try{places.events.assertPlayable(room);}catch{pause(room,'EVENT_NOT_ACTIVE');}change(room);}notifyWorld();} });
  const displayName=options.displayName??'PLY';
  if(typeof displayName!=='string'||!displayName.trim()||displayName.length>64||/[\u0000-\u001f]/.test(displayName))throw new Error('Invalid display name');
  const accountApi=createAccountApi({accounts,partyApi,rooms,sessions,places,isSecure:requestPolicy.isSecure,accountTlsRequired:publicOrigin.startsWith('https://'),roomFor,snapshot,pause,change,closeSocket,clientConfig:{displayName,apiOrigin:publicOrigin,phoneJoinUrl:options.phonePublicUrl??(publicOrigin?publicOrigin+'/play':''),sessionAccessKeyRequired:!!testAccessDigest,auth:accounts.describe()}});
  async function deadzoneRequest(path, init) {
    try {
      const response = await fetch(new URL(path, deadzoneOrigin), {
        ...init, redirect: 'error', signal: AbortSignal.timeout(3500)
      });
      if (!response.ok) throw new Error('upstream status');
      return await response.json();
    } catch {
      throw fail('DEADZONE_UNAVAILABLE', 'Game server did not respond', 502);
    }
  }

  async function handleDeadzone(req, res, roomId, body) {
    if (!deadzoneOrigin) throw fail('DEADZONE_DISABLED', 'Game integration is disabled', 404);
    const session = authenticate(req);
    const room = roomFor(roomId);
    const member = requireHost(room, session);
    const venue = venueGames.get(room);
    if (venue && venue.engine.phase !== 'END') throw fail('GAME_ALREADY_ACTIVE', 'Finish the charging game first', 409);
    if (!gate(room).allowed) throw fail('DEADZONE_PARK_REQUIRED', 'Park and open the vehicle app first', 409);
    if (deadzonePending.has(roomId)) throw fail('DEADZONE_BUSY', 'Game sync already in progress', 409);
    const epoch = room.roomEpoch;
    const scope = deadzoneScope(room);
    const socket = member.socket;
    deadzonePending.add(roomId);
    try {
      let match = linkedDeadzone(room);
      if (body.create === true && !room.collection.pendingRepair && (!match || match.state === 'ended')) {
        const riders = [...room.members.values()].filter(item => item.approved && passengerSeat(item.seat) &&
          seatEvidence(room, item.seat) !== 'EMPTY');
        const players = riders.length;
        const partySeats = riders.map(rider => ({ memberId: rider.memberId, seat: rider.seat, name: rider.nickname, ticket: randomUUID() }));
        if (!players || players > 4) throw fail('DEADZONE_PLAYERS', 'Approve one to four phones first', 409);
        const game = await deadzoneRequest('/api/zride/rooms', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ players, hostName: session.nickname, sharedVehicle: true, partySeats })
        });
        if (!/^[A-Z2-9]{6}$/.test(game.code) || !asText(game.dashboardToken, 128))
          throw fail('DEADZONE_BAD_ROOM', 'Invalid upstream room', 502);
        match = { code: game.code, dashboardToken: game.dashboardToken, cleared: 0, state: 'lobby', scope,
          ...(game.partySeatsRequired ? { partySeats: Object.fromEntries(partySeats.map(rider => [rider.memberId, rider.ticket])) } : {}) };
      }
      if (!match) return result(res, 200, { match: null });
      // The Worker can discard its room listing and return an empty lobby
      // after a finished game. Keep the result and let the host open a new room.
      let observed = match.finalObservation ?? await deadzoneRequest('/api/zride/rooms/' + match.code + '/status', {
        headers: { 'x-dashboard-token': match.dashboardToken }
      });
      if (observed.schema !== 'zride.dashboard.v1' || observed.roomCode !== match.code ||
          !Array.isArray(observed.players) || !Number.isSafeInteger(observed.wave))
        throw fail('DEADZONE_BAD_STATE', 'Invalid game snapshot', 502);
      if (match.state === 'ended' && observed.state !== 'ended') {
        observed = { ...observed, state: 'ended', wave: Math.max(match.cleared, observed.wave) };
      }
      if (storageFailed) throw unavailable();
      if (roomFor(roomId) !== room || memberFor(room, session) !== member || member.socket !== socket ||
          room.roomEpoch !== epoch || deadzoneScope(room) !== scope || !gate(room).allowed)
        throw fail('DEADZONE_STALE', 'Vehicle state changed during game sync', 409);

      if (body.repair === true) {
        const pending = room.collection.pendingRepair;
        if (!pending && (observed.state !== 'playing' || !['valley','choice'].includes(observed.phase) ||
            !observed.runId || !observed.vehicle || !(observed.vehicle.hp > 0 && observed.vehicle.hp < observed.vehicle.maxHp) ||
            observed.vehicle.repairedWave === observed.wave))
          throw fail('REPAIR_NOT_READY', 'Repair is available between waves on a damaged vehicle', 409);
        if (pending && pending.code !== match.code) throw fail('REPAIR_PENDING', 'Previous repair is awaiting confirmation', 409);
        if (!pending && room.collection.inventory.supplies < 1) throw fail('SUPPLY_REQUIRED', 'Collect a supply first', 409);
        const repair = pending ?? { code: match.code, runId: observed.runId, wave: observed.wave };
        if (!pending) atomic(() => {
          room.collection.inventory.supplies--;
          room.collection.pendingRepair = repair;
          room.deadzoneMatch = match;
          collectionChanged(room);
        });
        const outcome = await deadzoneRequest('/api/zride/rooms/' + match.code + '/repair', {
          method: 'POST', headers: { 'x-dashboard-token': match.dashboardToken, 'content-type': 'application/json' },
          body: JSON.stringify(repair)
        });
        if (typeof outcome.applied !== 'boolean') throw fail('DEADZONE_BAD_STATE', 'Invalid repair receipt', 502);
        atomic(() => {
          if (!outcome.applied) room.collection.inventory.supplies++;
          delete room.collection.pendingRepair;
          collectionChanged(room);
        });
        if (!outcome.applied) throw fail('REPAIR_NOT_READY', 'Repair window has closed', 409);
        observed = await deadzoneRequest('/api/zride/rooms/' + match.code + '/status', {
          headers: { 'x-dashboard-token': match.dashboardToken }
        });
      }

      const cleared = observed.phase === 'valley' || observed.phase === 'choice' ? observed.wave : 0;
      const finalObservation = observed.state === 'ended' ? {
        schema: observed.schema,
        roomCode: observed.roomCode,
        state: observed.state,
        wave: observed.wave,
        teamScore: observed.teamScore,
        vehicle: observed.vehicle,
        players: observed.players.slice(0, 4).map(({ name, score, kills }) => ({ name, score, kills })),
      } : undefined;
      const next = { ...match, state: observed.state, cleared: Math.max(match.cleared, cleared), finalObservation };
      const previous = room.deadzoneMatch;
      atomic(() => {
        room.deadzoneMatch = next;
        const playing = observed.state === 'playing';
        const context = effectContext(room, member, playing);
        let fx = effects.snapshot(roomId);
        if (fx.sceneId === 'deadzone-' + match.code && (!playing || body.enableAmbient !== true)) {
          applyEffects(room, effects.stop(context, playing ? 'USER_STOP' : 'MATCH_ENDED'));
          fx = effects.snapshot(roomId);
        }
        if (body.enableAmbient === true && !fx.enabled && playing && context.gate.allowed) {
          const enabled = effects.session(context, {
            commandId: randomUUID(), enabled: true, locallyEnabled: true,
            vehicleConnectionId: context.connectionId, expectedControlVersion: fx.controlVersion,
            channels: ['AMBIENT'], maxIntensity01: 0.25
          });
          fx = effects.snapshot(roomId);
          const scene = effects.scene(context, {
            commandId: randomUUID(), effectSessionId: fx.effectSessionId,
            sceneId: 'deadzone-' + match.code, virtualSpeedMps: 0
          });
          queueEffectEvents(room, enabled);
          applyEffects(room, scene);
          fx = effects.snapshot(roomId);
        }
        if (body.enableAmbient === true && playing && cleared > match.cleared && fx.enabled && fx.sceneId === 'deadzone-' + match.code &&
            fx.channels.includes('AMBIENT')) {
          applyEffects(room, effects.cue(context, {
            commandId: 'deadzone-' + match.code + '-' + cleared,
            effectSessionId: fx.effectSessionId, sceneId: fx.sceneId,
            cue: 'ESCAPE', intensity01: 0.25, durationMs: 2500
          }));
        }
        if (previous?.code !== next.code || (previous.state !== 'ended' && next.state === 'ended')) change(room);
      });
      return result(res, 200, { match: {
        state: observed.state, wave: observed.wave, cleared: next.cleared,
        score: observed.teamScore,
        vehicle: Number.isFinite(observed.vehicle?.hp) ? { hp: observed.vehicle.hp, maxHp: observed.vehicle.maxHp } : null,
        supplies: room.collection.inventory.supplies,
        repairAvailable: !!room.collection.pendingRepair || (room.collection.inventory.supplies > 0 &&
          observed.state === 'playing' && ['valley','choice'].includes(observed.phase) &&
          observed.vehicle?.hp > 0 && observed.vehicle.hp < observed.vehicle.maxHp && observed.vehicle.repairedWave !== observed.wave),
        players: observed.players.slice(0, 4).map(({ name, score, kills }) => ({ name, score, kills }))
      } });
    } finally {
      deadzonePending.delete(roomId);
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      rateLimit('http:' + requestPolicy.clientAddress(req));
      const path = new URL(req.url, 'http://localhost').pathname;
      if(requestPolicy.apply(req,res,path))return;
      if (req.method === 'GET' && path === '/healthz') return result(res, storageFailed ? 503 : 200, { ok: !storageFailed, protocol: 'zride-demo-v1', contractRevision: 10 });
      if (storageFailed) throw unavailable();
      if (observers.handleHttp(req, res, path)) return;
      if (phoneClient.handleHttp(req, res, path)) return;
      const body = req.method === 'POST' ? await readJson(req) : null;
      if(req.method==='POST'&&path==='/api/auth/google/exchange'){
        accountApi.requireGoogleTransport(req);
        const plan=atomic(()=>accounts.beginGoogle(body,accountApi.token(req)));
        const verified=await accounts.verifyGoogle(body.credential,plan);
        return atomic(()=>result(res,200,accounts.finishGoogle(plan,verified)));
      }
      const deadzoneRoute = path.match(/^\/api\/rooms\/([^/]+)\/deadzone$/);
      if (deadzoneRoute && req.method === 'POST') return await handleDeadzone(req, res, deadzoneRoute[1], body);
      const driveRoute = path.match(/^\/api\/rooms\/([^/]+)\/drive-game$/);
      if (driveRoute && req.method === 'POST') {
        const room = roomFor(driveRoute[1]);
        requireHost(room, authenticate(req));
        if (!gate(room).allowed) throw fail('GATE_CLOSED', 'Select a passenger game while parked', 409);
        if (!phoneClient.driveGamesAvailable) throw fail('DRIVE_GAMES_UNAVAILABLE', 'Passenger game assets are unavailable', 503);
        if (!driveGames.has(body?.game)) throw fail('INVALID_GAME', 'Unknown passenger game', 400);
        return atomic(() => {
          if (room.driveGame !== body.game) {
            room.driveGame = body.game;
            change(room);
          }
          return result(res, 200, { game: room.driveGame });
        });
      }
      const venueRoute = path.match(/^\/api\/rooms\/([^/]+)\/venue-game$/);
      if (venueRoute && req.method === 'POST') {
        const session = authenticate(req);
        const room = roomFor(venueRoute[1]);
        const apply = () => handleVenue(room, session, body);
        return result(res, 200, body.action === 'status' ? apply() : atomic(apply));
      }
      return atomic(() => {
      const accountResponse=accountApi.handle(req,path,body);if(accountResponse)return result(res,accountResponse.status,accountResponse.data);
      const publicResponse = partyApi.publicRequest(req,path,body);
      if (publicResponse) return result(res,publicResponse.status,publicResponse.data);
      if (req.method === 'POST' && path === '/api/session') {
        if (testAccessDigest && !(asText(body.accessKey, 1024) && timingSafeEqual(testAccessDigest, createHash('sha256').update(body.accessKey).digest()))) throw fail('TEST_ACCESS_REQUIRED', 'Valid team test access key required', 401);
        if (sessions.size >= 500) throw fail('SESSION_LIMIT', 'Demo session limit', 503);
        if (!['CAR_HOST', 'PHONE'].includes(body.role)) throw fail('INVALID_ROLE', 'CAR_HOST or PHONE required');
        if (!asText(body.nickname, 24)) throw fail('INVALID_NICKNAME', 'Nickname 1..24 characters');
        const credential = token();
        const session = { sessionId: randomUUID(), role: body.role, nickname: body.nickname, expiresAt: Date.now() + 8 * 3600000, roomId: null };
        sessions.set(createHash('sha256').update(credential).digest('hex'), session);
        return result(res, 201, { sessionId: session.sessionId, token: credential, expiresAt: session.expiresAt, role: session.role });
      }
      const session = authenticate(req);
      const partyResponse = partyApi.handle(req,path,body,session);
      if (partyResponse) return result(res,partyResponse.status,partyResponse.data);
      if (path === '/api/scenarios' && req.method === 'GET') return result(res, 200, { scenarios: gameState.scenarios() });
      if (path.startsWith('/api/world/')) {
        if (session.role !== 'PHONE') throw fail('ROLE_FORBIDDEN', 'World collection APIs are passenger-phone only', 403);
        const room = roomFor(session.roomId); const member = memberFor(room, session);
        if (!passengerSeat(member.seat) || member.role === 'CAR_HOST') throw fail('ROLE_FORBIDDEN', 'Approved passenger role required', 403);
        if (req.method !== 'POST') throw fail('METHOD_NOT_ALLOWED', 'Use authenticated POST JSON; coordinates do not belong in URL queries', 405);
        rateLimit('world:' + session.sessionId, 30);
        if (path === '/api/world/route-supply') {
          if (body.passengerConfirmed !== true || seatEvidence(room, member.seat) === 'EMPTY')
            throw fail('PASSENGER_CONFIRMATION_REQUIRED', 'Approved occupied or unverified passenger seat required', 403);
          const route = routeSupplyContext(room);
          if (!route)
            throw fail('ROUTE_SUPPLY_UNAVAILABLE', 'A fresh moving vehicle and active route are required', 409);
          const claimed = room.collection.routeClaims ??= {};
          if (body.challengeId !== undefined) {
            if (typeof body.challengeId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.challengeId))
              throw fail('ROUTE_CHALLENGE_INVALID', 'Invalid challenge ID', 400);
            const challenge = supplyChallenges.get(member);
            if (claimed[body.challengeId] === member.memberId) return result(res, 200, { supplies: room.collection.inventory.supplies, replayed: true });
            if (!challenge || challenge.id !== body.challengeId || challenge.routeKey !== route.key ||
                challenge.expiresAt < Date.now())
              throw fail('ROUTE_CHALLENGE_INVALID', 'The attempt is closed. Continue to the next spot', 409);
            supplyChallenges.delete(member);
            if (challenge.sequence !== body.sequence)
              return result(res, 200, { outcome: 'MISSED', supplies: room.collection.inventory.supplies });
            if (Object.hasOwn(claimed, challenge.spotId)) throw fail('ALREADY_CLAIMED', 'Party already collected at this spot', 409);
            claimed[challenge.spotId] = challenge.id;
            claimed[challenge.id] = member.memberId;
            room.collection.inventory.supplies++;
            collectionChanged(room);
            return result(res, 200, { supplies: room.collection.inventory.supplies });
          }
          const activeChallenge = supplyChallenges.get(member);
          if (activeChallenge?.routeKey === route.key && activeChallenge.expiresAt >= Date.now())
            throw fail('ROUTE_CHALLENGE_IN_PROGRESS', 'Finish the current attempt first', 409);
          const spot = availableRouteSupply(room, route, member);
          if (!spot || (body.placeId !== undefined && body.placeId !== spot.placeId))
            throw fail('ROUTE_SUPPLY_UNAVAILABLE', 'This spot is no longer available', 409);
          const challenge = { id: randomUUID(), spotId: spot.placeId, routeKey: route.key,
            sequence: Array.from({length: 4}, () => Math.floor(Math.random()*3)+1).join(''),
            expiresAt: Date.now()+30000 };
          supplyChallenges.set(member, challenge);
          const attempts = room.collection.routeAttempts ??= {};
          (attempts[member.memberId] ??= []).push(spot.placeId);
          broadcast(room);
          return result(res, 200, { challengeId: challenge.id, sequence: challenge.sequence, placeName: spot.name });
        }
        if (path === '/api/world/nearby') return result(res, 200, world.nearby(room,member, body));
        if (path === '/api/world/location') return result(res, 200, world.observe(member, body));
        if (path === '/api/world/claim') {
          const claimed = world.claim(room, member, body);
          if (!claimed.replayed) collectionChanged(room);
          return result(res, 200, claimed);
        }
        throw fail('NOT_FOUND', 'World route not found', 404);
      }
      if (req.method === 'POST' && path === '/api/rooms') {
        if (session.role !== 'CAR_HOST') throw fail('ROLE_FORBIDDEN', 'Vehicle session required', 403);
        if (session.roomId && rooms.has(session.roomId)) {
          const room = roomFor(session.roomId);
          joinCodes.delete(room.joinCode);
          room.joinCode = token().slice(0, 10).toUpperCase(); room.joinExpiresAt = Date.now() + pairingTtlMs; room.joinUsed = false;
          joinCodes.set(room.joinCode, room.roomId); change(room);
          return result(res, 200, { roomId: room.roomId, joinCode: room.joinCode, room: snapshot(room, memberFor(room, session)) });
        }
        const roomId = randomUUID(); const joinCode = token().slice(0, 10).toUpperCase();
        const member = { memberId: randomUUID(), sessionId: session.sessionId, nickname: session.nickname, role: 'CAR_HOST', seat: 'DRIVER', approved: true, socket: null, receipts: new Map() };
        const room = { roomId, roomEpoch: 0, stateVersion: 1, state: 'LOBBY', pauseReason: null, joinCode,
          joinExpiresAt: Date.now() + pairingTtlMs, joinUsed: false, members: new Map([[session.sessionId, member]]),
          vehicle: { ux: 'UNKNOWN', gear: 'UNKNOWN', foreground: false, seats: [], charge: { state: 'UNKNOWN', portConnection: 'UNKNOWN', source: 'NONE' }, source: 'UNKNOWN', receivedAt: 0, hostConnected: false },
          emptyLocks: new Set(),
          stats: { shots: 0, rejectedShots: 0, hits: 0, zombieHp: 5, zombieAngleDeg: 60, supportUntil: 0, supportCount: 0, supportDamage: 2, supportSupplyUsed: false, kills: 0, waveCleared: false, lastShot: null },
          zombies: newZombies(),
          collection: { inventory: { supplies: 0 }, lastCollect: null }, game: gameState.initial(),
          partyWorldClaims:new Map(),partyPickupClaims:new Set(),collectionRevision:0,
          partyPickupRespawns:new Map(),
        };
        session.roomId = roomId; rooms.set(roomId, room); joinCodes.set(joinCode, roomId);
        return result(res, 201, { roomId, joinCode, room: snapshot(room, member) });
      }
      if (req.method === 'POST' && path === '/api/join') {
        if(session.accountUserId)throw fail('ACCOUNT_PARTY_JOIN_REQUIRED','Use the phone account invitation flow',403);
        if (session.role !== 'PHONE') throw fail('ROLE_FORBIDDEN', 'Phone session required', 403);
        if (!asText(body.joinCode, 64) || !passengerSeat(body.seat)) throw fail('INVALID_JOIN', 'joinCode and valid seat required');
        const room = roomFor(joinCodes.get(body.joinCode.toUpperCase()));
        if (room.joinExpiresAt <= Date.now()) throw fail('PAIRING_EXPIRED', 'Ask host for a new code', 409);
        if (room.joinUsed) throw fail('PAIRING_USED', 'Ask host for a new code', 409);
        if (session.roomId && session.roomId !== room.roomId) throw fail('ALREADY_JOINED', 'Session already has a room', 409);
        if (room.members.size >= 4) throw fail('ROOM_FULL', 'Maximum host plus 3 phones', 409);
        if (room.members.has(session.sessionId)) throw fail('ALREADY_JOINED', 'Already joined', 409);
        const departed = room.departedMembers?.get(session.sessionId);
        const member = { ...(departed??{}), memberId: departed?.memberId ?? randomUUID(), sessionId: session.sessionId, nickname: session.nickname, role: body.seat, seat: body.seat, approved: false, socket: null, receipts: departed?.receipts ?? new Map(), collectedPickups: departed?.collectedPickups ?? new Set() };
        room.departedMembers?.delete(session.sessionId);
        room.members.set(session.sessionId, member); session.roomId = room.roomId; room.joinUsed = true;
        change(room);
        return result(res, 201, { roomId: room.roomId, memberId: member.memberId, pending: true, room: snapshot(room, member) });
      }
      const stateRoute = path.match(/^\/api\/rooms\/([^/]+)\/state$/);
      if (stateRoute && req.method === 'GET') {
        const room = roomFor(stateRoute[1]); const member = memberFor(room, session);
        return result(res, 200, { room: snapshot(room, member), serverTime: Date.now() });
      }
      const gameRoute = path.match(/^\/api\/rooms\/([^/]+)\/game\/(configure|input|advance|interact)$/);
      if (gameRoute) {
        const room = roomFor(gameRoute[1]); const member = memberFor(room, session);
        if (req.method !== 'POST') throw fail('METHOD_NOT_ALLOWED', 'Game actions require POST JSON', 405);
        const operation = gameRoute[2];
        if (operation !== 'interact') requireHost(room, session);
        if (!asText(body.commandId, 128)) throw fail('COMMAND_ID_REQUIRED', 'Unique commandId required');
        let outcome, logicalData;
        if (operation === 'input') {places.events.assertPlayable(room);outcome = gameState.input(room.game, gameContext(room, member), body);}
        else {
          member.gameReceipts ??= new Map();
          const fingerprint = hash(canonical({ operation, body })); const old = member.gameReceipts.get(body.commandId);
          if (old) {
            if (old.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_CONFLICT', 'Same game command ID with different input', 409);
            return result(res, 200, { room: snapshot(room, member), data: old.data, replayed: true });
          }
          if (member.gameReceipts.size >= maxReceipts) throw fail('COMMAND_LIMIT', 'Game command receipt capacity reached', 429);
          if(operation!=='configure')places.events.assertPlayable(room);else places.events.ensureConfigure(body.scenarioId);
          outcome = gameState[operation](room.game, gameContext(room, member), body);
          logicalData = gameState.durable(room.game);
          member.gameReceipts.set(body.commandId, { fingerprint, data: logicalData });
        }
        logicalData ??= gameState.durable(room.game);
        if (operation === 'configure') { room.roomEpoch++; resetCombat(room); queueEffectEvents(room, effects.stop(effectContext(room), 'MISSION_CONFIGURED')); }
        if (operation === 'advance' && room.game.stageId === 'DEFEND') resetCombat(room);
        if (operation === 'advance' && room.game.stageId === 'COMPLETE') { room.state = 'CLEARED'; room.roomEpoch++; }
        if (outcome.changed) change(room);
        return result(res, 200, { room: snapshot(room, member), data: logicalData, replayed: outcome.replayed === true });
      }
      const effectRoute = path.match(/^\/api\/rooms\/([^/]+)\/effects(?:\/(session|scene|cue|stop))?$/);
      if (effectRoute) {
        const room = roomFor(effectRoute[1]); const member = memberFor(room, session);
        if (req.method === 'GET' && !effectRoute[2]) {
          applyEffects(room, effects.tick(effectContext(room)));
          return result(res, 200, { effects: effects.snapshot(room.roomId) });
        }
        if (req.method !== 'POST' || !effectRoute[2]) throw fail('METHOD_NOT_ALLOWED', 'Use the documented effects method', 405);
        requireHost(room, session);
        const operation = effectRoute[2];
        if (operation === 'scene' && room.game.scenarioId === 'heist-demo-v1') throw fail('GAME_SCENE_MANAGED', 'Mission motion owns the virtual scene; use game inputs', 409);
        const outcome = effects[operation](effectContext(room, member), body);
        return result(res, 200, applyEffects(room, outcome));
      }
      const match = path.match(/^\/api\/rooms\/([^/]+)(?:\/(approve))?$/);
      if (match) {
        const room = roomFor(match[1]);
        if (req.method === 'GET' && !match[2]) return result(res, 200, { room: snapshot(room, memberFor(room, session, false)) });
        if (req.method === 'POST' && match[2] === 'approve') {
          requireHost(room, session);
          const member = [...room.members.values()].find(m => m.memberId === body.memberId);
          if (!member || member.role === 'CAR_HOST') throw fail('MEMBER_NOT_FOUND', 'Pending member not found', 404);
          const seat = body.seat ?? member.seat;
          if (!passengerSeat(seat)) throw fail('INVALID_SEAT', 'Passenger seat required');
          if (member.approved && member.seat !== seat && room.state === 'PLAYING') throw fail('REASSIGN_REQUIRES_PAUSE', 'Pause before changing a seat', 409);
          if ([...room.members.values()].some(m => m !== member && m.approved && m.seat === seat)) throw fail('SEAT_TAKEN', 'Seat already assigned', 409);
          accountApi.approve(room,member);
          member.seat = seat; member.role = seat; member.approved = true; change(room);
          const observed = room.vehicle.seats.find(s => s.seat === seat)?.occupancy ?? 'UNKNOWN';
          if (body.allowManualUnknown === true && observed === 'UNKNOWN') { room.emptyLocks.delete(seat); change(room); }
          return result(res, 200, { room: snapshot(room, memberFor(room, session)) });
        }
      }
      throw fail('NOT_FOUND', 'Route not found', 404);
      });
    } catch (error) { req.on('error',()=>{});req.resume();result(res, error.status ?? 500, { error: { code: error.code ?? 'INTERNAL_ERROR', message: error.code ? error.message : 'Internal error' } }); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: BODY_LIMIT, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (storageFailed || closing) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return; }
    if (observers.handleUpgrade(req, socket, head)) return;
    if (new URL(req.url, 'http://localhost').pathname !== '/ws') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    const origin = req.headers.origin;
    const allowedOrigin = requestPolicy.acceptedOrigin(origin,req);
    if (!allowedOrigin) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    if (sockets.size >= 100) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  function perform(room, member, message) {
    if(message.type==='navigation.report'){
      if(member.role!=='CAR_HOST')throw fail('ROLE_FORBIDDEN','Only vehicle can report navigation',403);
      if(!Number.isSafeInteger(message.reportSeq)||message.reportSeq<1||message.reportSeq<=(member.lastNavigationSeq??0))throw fail('STALE_REPORT','Navigation sequence must increase',409);
      const value=navigationReport(message.navigation);member.lastNavigationSeq=message.reportSeq;
      room.navigation={...value,revision:(room.navigation?.revision??0)+1};
      const r=places.routeInfo(room.roomId);
      if(value.sdkConnected&&(value.owned||value.status==='ROUTE_DRIVE')&&r.active&&r.source==='DEMO_ROUTE')places.setRoute(room.roomId,{commandId:randomUUID(),expectedRouteRevision:r.routeRevision,source:'NONE'});
      change(room);return {reported:true,navigationRevision:room.navigation.revision};
    }
    if (message.type === 'vehicle.report') {
      if (member.role !== 'CAR_HOST') throw fail('ROLE_FORBIDDEN', 'Only vehicle can report state', 403);
      if (!UX.includes(message.ux) || !GEARS.includes(message.gear)) throw fail('INVALID_REPORT', 'Explicit UX and gear required');
      if (message.foreground != null && typeof message.foreground !== 'boolean') throw fail('INVALID_REPORT', 'foreground must be boolean');
      if (message.speedMps != null && (!Number.isFinite(message.speedMps) || message.speedMps < 0 || message.speedMps > 120))
        throw fail('INVALID_REPORT', 'speedMps must be within 0–120 m/s');
      if (message.reportSeq != null && (!Number.isSafeInteger(message.reportSeq) || message.reportSeq <= (member.lastReportSeq ?? 0))) throw fail('STALE_REPORT', 'reportSeq must increase on this connection', 409);
      if (message.seats != null && (!Array.isArray(message.seats) || message.seats.length > 4)) throw fail('INVALID_REPORT', 'At most four seat reports');
      const seats = (message.seats ?? []).map(s => {
        if (!SEATS.includes(s.seat) || !OCCUPANCY.includes(s.occupancy)) throw fail('INVALID_REPORT', 'Invalid seat observation');
        return { seat: s.seat, occupancy: s.occupancy };
      });
      if (new Set(seats.map(s => s.seat)).size !== seats.length) throw fail('INVALID_REPORT', 'Duplicate seat observations');
      for (const s of seats) {
        if (s.occupancy === 'EMPTY') room.emptyLocks.add(s.seat);
        if (s.occupancy === 'OCCUPIED') room.emptyLocks.delete(s.seat);
      }
      if (message.reportSeq != null) member.lastReportSeq = message.reportSeq;
      room.vehicle = { ux: message.ux, gear: message.gear, foreground: message.foreground ?? true, seats,
        speedMps: message.speedMps ?? null,
        charge: { state: String(message.charge?.state ?? 'UNKNOWN').slice(0, 32), portConnection: String(message.charge?.portConnection ?? 'UNKNOWN').slice(0, 32), source: String(message.charge?.source ?? 'NONE').slice(0, 32),
          ...(Number.isFinite(message.charge?.socPercent) && message.charge.socPercent >= 0 && message.charge.socPercent <= 100
            ? { socPercent: message.charge.socPercent } : {}) },
        source: String(message.source ?? 'CLIENT_REPORT').slice(0, 64), receivedAt: Date.now(), hostConnected: true };
      updateVenue(room);
      const g = gate(room);
      if (!g.allowed) pause(room, g.reasons.join(','));
      else if (room.state === 'LOBBY') room.state = 'READY';
      change(room); return { reported: true, gateAllowed: g.allowed };
    }
    if (message.type !== 'command') throw fail('INVALID_MESSAGE', 'command or vehicle.report required');
    if (!member.approved) throw fail('MEMBER_PENDING', 'Vehicle approval required', 403);
    if (message.action === 'mobile.collect') {
      if (member.role === 'CAR_HOST' || !passengerSeat(member.seat)) throw fail('ROLE_FORBIDDEN', 'Only an approved passenger can collect', 403);
      if (message.passengerConfirmed !== true) throw fail('PASSENGER_CONFIRMATION_REQUIRED', 'Confirm that you are a passenger, not the driver', 403);
      const pickup = PICKUPS.find(p => p.pickupId === message.pickupId);
      if (!pickup) throw fail('PICKUP_NOT_FOUND', 'Known DEMO_PICKUP fixture required', 404);
      world.consumeFixture(room,pickup.pickupId);
      member.collectedPickups.add(pickup.pickupId);
      room.partyPickupClaims.add(pickup.pickupId);
      room.collection.inventory.supplies += pickup.amount;
      room.collection.lastCollect = { memberId: member.memberId, pickupId: pickup.pickupId, amount: pickup.amount, at: Date.now() };
      collectionChanged(room);
      return { pickupId: pickup.pickupId, amount: pickup.amount, inventory: { ...room.collection.inventory }, mode: 'DEMO_PICKUP', gpsVerified: false };
    }
    if (message.action === 'round.pause') { pause(room, 'USER_PAUSE'); return { paused: true }; }
    if (!Number.isInteger(message.roomEpoch) || message.roomEpoch !== room.roomEpoch) throw fail('STALE_EPOCH', 'Refresh snapshot before sending another action', 409);
    const g = gate(room);
    if (!g.allowed) { pause(room, g.reasons.join(',')); throw fail('GATE_CLOSED', g.reasons.join(','), 409); }
    if (message.action === 'round.start') {
      places.events.assertPlayable(room);
      if (member.role !== 'CAR_HOST') throw fail('ROLE_FORBIDDEN', 'Vehicle starts round', 403);
      if (room.state === 'PLAYING') throw fail('ALREADY_PLAYING', 'Round already playing', 409);
      if (room.game.completed) throw fail('MISSION_COMPLETE', 'Configure a new mission before starting again', 409);
      const activePhone = [...room.members.values()].some(m => m.role !== 'CAR_HOST' && m.approved && m.socket && seatEvidence(room, m.seat) !== 'EMPTY');
      if (!activePhone) throw fail('OPERATOR_REQUIRED', 'At least one approved phone in a non-empty seat required', 409);
      if(['supply-run-v1','signal-puzzle-v1'].includes(room.game.scenarioId)&&[...room.members.values()].filter(m=>m.role!=='CAR_HOST'&&m.approved&&m.socket?.readyState===WebSocket.OPEN&&seatEvidence(room,m.seat)!=='EMPTY').length<2)throw fail('MISSION_CREW_REQUIRED','Two connected approved phones required for this cooperative mission',409);
      if (['heist-demo-v1','zombie-defense-v1'].includes(room.game.scenarioId)) {
        const crew = [...room.members.values()].filter(m => m.role !== 'CAR_HOST' && m.approved
          && m.socket?.readyState === WebSocket.OPEN && seatEvidence(room, m.seat) !== 'EMPTY');
        const uncovered = room.zombies.some(zombie => zombie.hp > 0 && !crew.some(m => {
          const sector = SECTORS[m.seat];
          return sector && (zombie.angleDeg >= sector[0] && zombie.angleDeg <= sector[1]
            || Math.abs(zombie.angleDeg) === 180 && ['REAR_LEFT', 'REAR_RIGHT'].includes(m.seat));
        }));
        if (uncovered) throw fail('HEIST_CREW_REQUIRED', 'Connected approved crew must cover all defense target angles; this preset needs REAR_LEFT and REAR_RIGHT', 409);
      }
      if (room.state === 'CLEARED') { room.zombies = newZombies(); room.stats.waveCleared = false; }
      room.state = 'PLAYING'; room.pauseReason = null; room.roomEpoch++; change(room); return { started: true };
    }
    if (room.state !== 'PLAYING') throw fail('NOT_PLAYING', 'Explicit vehicle start/resume required', 409);
    places.events.assertPlayable(room);
    if (message.action === 'support.pulse') {
      if (!['generic-coop-v1'].includes(room.game.scenarioId) && room.game.stageId !== 'DEFEND') throw fail('GAME_ACTION_UNAVAILABLE', 'Combat support belongs to the defense mini-game', 409);
      if (member.role !== 'CAR_HOST') throw fail('ROLE_FORBIDDEN', 'Vehicle support only', 403);
      if (room.stats.supportUntil > Date.now()) throw fail('SUPPORT_COOLDOWN', 'Support is already active', 409);
      if (room.collection.inventory.supplies < 1) throw fail('SUPPLY_REQUIRED', 'Collect one demo supply before vehicle support', 409);
      const consumed = 1;
      room.collection.inventory.supplies--;
      room.stats.supportDamage = 3;
      room.stats.supportSupplyUsed = true;
      room.stats.supportUntil = Date.now() + 5000; room.stats.supportCount++; change(room);
      return { supportUntil: room.stats.supportUntil, supportDamage: room.stats.supportDamage, suppliesConsumed: consumed, inventory: { ...room.collection.inventory } };
    }
    if (message.action === 'fire') {
      if (!['generic-coop-v1'].includes(room.game.scenarioId) && room.game.stageId !== 'DEFEND') throw fail('GAME_ACTION_UNAVAILABLE', 'Shooting belongs to the defense mini-game', 409);
      const sector = SECTORS[member.seat];
      if (!sector) throw fail('ROLE_FORBIDDEN', 'Driver is commander, not shooter', 403);
      if (seatEvidence(room, member.seat) === 'EMPTY') throw fail('SEAT_EMPTY', 'Assigned seat is reported empty', 409);
      if (typeof message.angleDeg !== 'number' || !Number.isFinite(message.angleDeg) || message.angleDeg < -180 || message.angleDeg > 180) throw fail('INVALID_ANGLE', 'Finite angle -180..180 required');
      const rearBoundary = Math.abs(message.angleDeg) === 180 && ['REAR_LEFT', 'REAR_RIGHT'].includes(member.seat);
      if (!rearBoundary && (message.angleDeg < sector[0] || message.angleDeg > sector[1])) {
        room.stats.rejectedShots++;
        room.stats.lastShot = { memberId: member.memberId, angleDeg: message.angleDeg, accepted: false, hit: false, targetId: null, damage: 0, time: Date.now() };
        change(room); throw fail('ANGLE_OUTSIDE_SECTOR', `Allowed ${sector[0]}..${sector[1]} degrees`, 409);
      }
      room.stats.shots++;
      const target = room.zombies.filter(z => z.hp > 0).sort((a,b) => angularDistance(a.angleDeg, message.angleDeg) - angularDistance(b.angleDeg, message.angleDeg))[0];
      const hit = !!target && angularDistance(message.angleDeg, target.angleDeg) <= 15;
      const damage = hit ? (room.stats.supportUntil > Date.now() ? room.stats.supportDamage : 1) : 0;
      if (hit) room.stats.hits++;
      if (hit) {
        target.hp = Math.max(0, target.hp - damage);
        room.stats.zombieHp = target.hp; room.stats.zombieAngleDeg = target.angleDeg;
        if (target.hp === 0) room.stats.kills++;
      }
      room.stats.lastShot = { memberId: member.memberId, angleDeg: message.angleDeg, accepted: true, hit, targetId: hit ? target.id : null, damage, time: Date.now() };
      room.stats.waveCleared = room.zombies.every(z => z.hp === 0);
      if (room.stats.waveCleared && room.game.scenarioId === 'generic-coop-v1') { room.state = 'CLEARED'; room.roomEpoch++; }
      change(room); return { hit, damage, targetId: hit ? target.id : null, targetHp: hit ? target.hp : null, angleDeg: message.angleDeg };
    }
    throw fail('UNKNOWN_ACTION', 'Unknown game action');
  }
  wss.on('connection', ws => {
    sockets.add(ws); let current = null;
    const authTimer = setTimeout(() => ws.close(4401, 'Authenticate first'), 5000);
    ws.on('error', () => {});
    ws.on('message', data => {
      try {
        atomic(() => {
        let message;
        try { message = JSON.parse(data.toString('utf8')); } catch { throw fail('INVALID_JSON', 'JSON required'); }
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw fail('INVALID_MESSAGE', 'JSON object required');
        if (!current) {
          if (message.type !== 'auth') throw fail('AUTH_REQUIRED', 'First message must be auth', 401);
          const session = findSession(message.token);
          if (!session || session.expiresAt <= Date.now()) throw fail('AUTH_EXPIRED', 'Invalid session', 401);
          const room = roomFor(message.roomId); const member = memberFor(room, session, false);
          if (member.socket && member.socket !== ws) {
            if (member.role === 'CAR_HOST') queueEffectEvents(room, effects.stop(effectContext(room), 'CONNECTION_REPLACED'), member.socket);
            closeSocket(member.socket, 4409, 'Connection replaced');
          }
          member.socket = ws; current = { session, room, member }; clearTimeout(authTimer);
          if (member.role === 'CAR_HOST') {
            ws.effectConnectionId = randomUUID(); ws.effectExpiresAt = session.expiresAt;
            member.lastReportSeq = 0;
            member.lastNavigationSeq=0;room.navigation=null;
            pause(room, 'VEHICLE_RECONNECTED'); room.vehicle.receivedAt = 0; room.vehicle.hostConnected = true;
            room.vehicle.ux = 'UNKNOWN'; room.vehicle.gear = 'UNKNOWN';
            room.vehicle.foreground = false;
          }
          send(ws, { type: 'auth.ok', sessionId: session.sessionId, memberId: member.memberId,
            ...(member.role === 'CAR_HOST' ? { vehicleConnectionId: ws.effectConnectionId } : {}) });
          change(room); return;
        }
        const { session, room, member } = current;
        if (member.socket !== ws) throw fail('CONNECTION_REPLACED', 'Old connection cannot send commands', 403);
        if (session.expiresAt <= Date.now()) { closeSocket(ws, 4401, 'Session expired'); return; }
        rateLimit('ws:' + session.sessionId, 120);
        if (!asText(message.commandId, 128)) throw fail('COMMAND_ID_REQUIRED', 'Unique commandId required');
        if (message.type === 'world.subscribe') {
          memberFor(room,session); const data = places.shared(message.spotId,rooms.values());
          ws.worldSpotId = message.spotId; ws.worldSession = session;
          send(ws,{type:'world.snapshot',...data});send(ws,{type:'result',commandId:message.commandId,ok:true,data:{subscribed:true},roomEpoch:room.roomEpoch});return;
        }
        if (message.type === 'world.unsubscribe') { ws.worldSpotId=null;send(ws,{type:'result',commandId:message.commandId,ok:true,data:{subscribed:false},roomEpoch:room.roomEpoch});return; }
        if (message.type === 'vehicle.cabin.report') {
          let response;
          try {
            const outcome = cabin.report(cabinContext(room, member), message);
            if (outcome.changed) change(room);
            response = { type: 'result', commandId: message.commandId, ok: true,
              data: { cabin: cabin.snapshot(cabinContext(room, member)), replayed: outcome.replayed === true }, roomEpoch: room.roomEpoch };
          } catch (error) {
            response = { type: 'result', commandId: message.commandId, ok: false,
              error: { code: error.code ?? 'INTERNAL_ERROR', message: error.code ? error.message : 'Internal error' }, roomEpoch: room.roomEpoch };
          }
          send(ws, response); return;
        }
        if (message.type === 'vehicle.effect.report') {
          let response;
          try {
            const data = applyEffects(room, effects.report(effectContext(room, member), message));
            response = { type: 'result', commandId: message.commandId, ok: true, data, roomEpoch: room.roomEpoch };
          } catch (error) {
            response = { type: 'result', commandId: message.commandId, ok: false,
              error: { code: error.code ?? 'INTERNAL_ERROR', message: error.code ? error.message : 'Internal error' }, roomEpoch: room.roomEpoch };
          }
          send(ws, response); return;
        }
        const fingerprint = hash(message);
        const receipt = member.receipts.get(message.commandId);
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_CONFLICT', 'Same commandId with a different message', 409);
          send(ws, receipt.response); return;
        }
        if (member.receipts.size >= maxReceipts) {
          send(ws, { type: 'result', commandId: message.commandId, ok: false, error: { code: 'COMMAND_LIMIT', message: 'Demo command capacity reached; no action applied' }, roomEpoch: room.roomEpoch });
          closeSocket(ws, 4429, 'Demo command limit reached'); return;
        }
        let response;
        try { response = { type: 'result', commandId: message.commandId, ok: true, data: perform(room, member, message), roomEpoch: room.roomEpoch }; }
        catch (error) { response = { type: 'result', commandId: message.commandId, ok: false, error: { code: error.code ?? 'INTERNAL_ERROR', message: error.code ? error.message : 'Internal error' }, roomEpoch: room.roomEpoch }; }
        member.receipts.set(message.commandId, { fingerprint, response }); send(ws, response);
        });
      } catch (error) {
        send(ws, { type: 'result', commandId: null, ok: false, error: { code: error.code ?? 'INTERNAL_ERROR', message: error.code ? error.message : 'Internal error' } });
        if (!current) ws.close(4401, 'Authentication failed');
      }
    });
    ws.on('close', () => {
      try { atomic(() => {
      clearTimeout(authTimer); sockets.delete(ws);
      if (!current || current.member.socket !== ws) return;
      const { room, member } = current; member.socket = null;
      if (member.role === 'CAR_HOST') { room.vehicle.hostConnected = false; room.vehicle.receivedAt = 0; pause(room, 'CAR_DISCONNECTED'); }
      change(room);
      }); } catch { clearTimeout(authTimer); sockets.delete(ws); }
    });
  });
  const gateTimer = setInterval(() => {
    for (const room of rooms.values()) if (!storageFailed && room.state === 'PLAYING' && !gate(room).allowed) {
      try { atomic(() => pause(room, gate(room).reasons.join(','))); } catch {}
    }
    if (!storageFailed) for (const room of rooms.values()) {
      try {
        updateVenue(room);
        const motion = gameState.tick(room.game, gameContext(room));
        const observations = cabin.tick(cabinContext(room));
        const fx = effects.snapshot(room.roomId), last = autoEffects.get(room.roomId);
        const renewalDue = room.game.scenarioId === 'heist-demo-v1' && fx.enabled && (!last || (options.effectsClock ?? Date.now)() - last.at >= 2000);
        if (motion.changed || observations.changed || renewalDue) atomic(() => change(room));
        const outcome = effects.tick(effectContext(room));
        if (outcome.changed) atomic(() => applyEffects(room, outcome));
      } catch {}
    }
    for (const room of rooms.values()) for (const member of room.members.values()) world.pruneQuality(member);
    if(!storageFailed)for(const room of rooms.values())if(!room.closedAt&&world.tick(room)){try{atomic(()=>collectionChanged(room));}catch{}}
    if(!storageFailed&&places.events.due()){try{atomic(()=>{if(places.events.tick()){for(const room of rooms.values())if(!room.closedAt){try{places.events.assertPlayable(room);}catch{pause(room,'EVENT_NOT_ACTIVE');}change(room);}notifyWorld();}});}catch{}}
    for (const [key, value] of requestBuckets) if (value.until < Date.now()) requestBuckets.delete(key);
  }, 250);
  gateTimer.unref();
  return {
    server,
    persistence: storage?.kind ?? 'memory',
    async listen(port = options.port ?? 8000, host = options.host ?? '127.0.0.1') {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
      listening = true; return server.address();
    },
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(gateTimer);
      await observers.close();
      for (const ws of sockets) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      if (listening) await new Promise(resolve => server.close(resolve));
      storage?.close();
    },
  };
}

function isDirectEntrypoint() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isDirectEntrypoint()) {
  const app = createDemoServer({ ...deploymentOptions(), deadzoneOrigin: process.env.ZRIDE_DEADZONE_ORIGIN, dbPath: (process.env.GAME_DB_PATH??process.env.ZRIDE_DB_PATH) || resolve('data/zride.sqlite'), observerToken: process.env.GAME_OBSERVER_TOKEN??process.env.ZRIDE_OBSERVER_TOKEN ?? '', testAccessKey: process.env.GAME_TEST_ACCESS_KEY??process.env.ZRIDE_TEST_ACCESS_KEY ?? '', placesPath: process.env.GAME_PLACES_PATH??process.env.ZRIDE_PLACES_PATH, placeReviewToken: process.env.GAME_PLACE_REVIEW_TOKEN??process.env.ZRIDE_PLACE_REVIEW_TOKEN, publicOrigin: process.env.GAME_PUBLIC_ORIGIN??process.env.ZRIDE_PUBLIC_ORIGIN });
  const address = await app.listen(Number(process.env.PORT ?? 8000), process.env.HOST ?? '127.0.0.1');
  console.log(JSON.stringify({ event: 'server.ready', address, protocol: 'zride-demo-v1', contractRevision: 10, persistence: app.persistence, exposure: (process.env.GAME_TEST_ACCESS_KEY??process.env.ZRIDE_TEST_ACCESS_KEY) ? 'team-test-key-protected' : 'local-debug' }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
