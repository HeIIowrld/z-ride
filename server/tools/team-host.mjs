import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const { values } = parseArgs({ allowNegative: true, options: {
  base: { type: 'string', default: 'http://127.0.0.1:8000' },
  durationsec: { type: 'string', default: '1800' },
  'invite-file': { type: 'string' },
  'auto-start': { type: 'boolean', default: true },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('node tools/team-host.mjs --base http://127.0.0.1:8000 --invite-file ../work/team-invite.private.json [--durationsec 1800] [--no-auto-start]');
  console.log('TEST ONLY: simulated P/UX vehicle, auto-approves requested passenger seats, auto-starts by default. Creates no PHONE sessions.');
  console.log('Set ZRIDE_TEST_ACCESS_KEY privately in environment. Invite file must be a *.private.json directly inside the repository ignored work/ directory. No credentials/codes are printed.');
  process.exit(0);
}
const baseUrl = new URL(values.base);
if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || !['', '/'].includes(baseUrl.pathname)) throw new Error('--base must be a plain HTTP(S) origin');
const base = baseUrl.origin;
const seconds = Number(values.durationsec);
if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400) throw new Error('--durationsec must be 1..86400');
if (!values['invite-file']) throw new Error('--invite-file is required');
const privateDir = fileURLToPath(new URL('../../work/', import.meta.url));
const invitePath = resolve(values['invite-file']);
if (dirname(invitePath) !== resolve(privateDir) || !basename(invitePath).endsWith('.private.json')) throw new Error('--invite-file must be a *.private.json directly inside ignored repository work/');
const seats = ['FRONT_PASSENGER', 'REAR_LEFT', 'REAR_RIGHT'];
const log = (event, detail = {}) => console.log(JSON.stringify({ event, simulated: true, source: 'SIMULATED_API_CLIENTS', ...detail }));
let hostToken, roomId, room, ws, interval, duration, stopping = false, ticking = false, reportSeq = 0;
let lastReport = 0, lastInvite = 0, invite, stopPromise;
let finish;
const finished = new Promise(resolveDone => { finish = resolveDone; });
const waiters = new Map();
const approvalFailures = new Set();

async function post(path, body) {
  if (path === '/api/session' && process.env.ZRIDE_TEST_ACCESS_KEY) body = { ...body, accessKey: process.env.ZRIDE_TEST_ACCESS_KEY };
  const response = await fetch(base + path, { method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { 'content-type': 'application/json', ...(hostToken ? { authorization: 'Bearer ' + hostToken } : {}) }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error('HTTP_' + response.status + '_' + (value.error?.code ?? 'ERROR'));
  return value;
}
function wait(key) {
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => { waiters.delete(key); reject(new Error('WS_TIMEOUT')); }, 8000);
    waiters.set(key, { resolve: resolveWait, reject, timer });
  });
}
function settle(key, value) {
  const pending = waiters.get(key);
  if (pending) { clearTimeout(pending.timer); waiters.delete(key); pending.resolve(value); }
}
async function send(message) {
  if (ws?.readyState !== WebSocket.OPEN) throw new Error('WS_DISCONNECTED');
  const response = wait(message.commandId);
  ws.send(JSON.stringify(message));
  const result = await response;
  if (!result.ok) throw new Error('WS_' + (result.error?.code ?? 'ERROR'));
  return result;
}
const command = action => send({ type: 'command', commandId: randomUUID(), roomEpoch: room.roomEpoch, action });
async function writeInvite(status = 'ACTIVE') {
  const freeSeats = seats.filter(seat => !room?.members.some(member => member.seat === seat));
  const value = { url: base + '/play', roomId, joinCode: status === 'ACTIVE' && freeSeats.length ? invite?.joinCode ?? null : null,
    expiresAt: status === 'ACTIVE' && freeSeats.length ? invite?.room.joinExpiresAt ?? 0 : 0,
    freeSeats, status, autoStart: values['auto-start'], source: 'SIMULATED_API_CLIENTS', updatedAt: new Date().toISOString() };
  const temporary = invitePath + '.partial';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, invitePath);
}
async function report() {
  await send({ type: 'vehicle.report', commandId: randomUUID(), reportSeq: ++reportSeq, ux: 'ALLOWED', gear: 'P', foreground: true,
    seats: seats.map(seat => ({ seat, occupancy: 'UNKNOWN' })), source: 'SIMULATED_API_CLIENTS',
    charge: { state: 'UNKNOWN', portConnection: 'UNKNOWN', source: 'SIMULATED_API_CLIENTS' } });
  lastReport = Date.now();
}
async function tick() {
  if (stopping || ticking) return;
  ticking = true;
  try {
    if (Date.now() - lastReport >= 2000) await report();
    for (const member of room.members.filter(member => member.role !== 'CAR_HOST' && !member.approved && seats.includes(member.seat))) {
      if (stopping || approvalFailures.has(member.memberId)) continue;
      try {
        const approved = await post('/api/rooms/' + roomId + '/approve', { memberId: member.memberId, seat: member.seat, allowManualUnknown: true });
        room = approved.room;
        log('team-host.passenger-approved', { seat: member.seat });
      } catch (error) {
        if (error.message === 'HTTP_409_SEAT_TAKEN') { approvalFailures.add(member.memberId); log('team-host.seat-unavailable', { seat: member.seat }); }
        else throw error;
      }
    }
    if (stopping) return;
    if (values['auto-start'] && ['READY', 'LOBBY'].includes(room.state) && room.members.some(member => member.role !== 'CAR_HOST' && member.approved && member.connected)) {
      await command('round.start');
      log('team-host.test-round-started');
    }
    const freeSeats = seats.filter(seat => !room.members.some(member => member.seat === seat));
    if (freeSeats.length && (!room.joinCode || Date.now() - lastInvite >= 90000)) {
      invite = await post('/api/rooms', {}); room = invite.room; lastInvite = Date.now();
      if (!stopping) { await writeInvite(); log('team-host.invite-refreshed', { freeSeatCount: freeSeats.length }); }
    } else if (freeSeats.length === 0 && invite?.joinCode) { invite = null; await writeInvite(); log('team-host.room-full'); }
  } finally { ticking = false; }
}
function stop(reason) {
  if (stopPromise) return stopPromise;
  stopping = true; clearInterval(interval); clearTimeout(duration);
  stopPromise = (async () => {
    if (ws?.readyState === WebSocket.OPEN && room) {
      try { await Promise.race([command('round.pause'), new Promise(resolvePause => setTimeout(resolvePause, 800))]); } catch { /* Disconnect also closes the vehicle lease. */ }
    }
    ws?.terminate();
    for (const pending of waiters.values()) { clearTimeout(pending.timer); pending.reject(new Error('WS_DISCONNECTED')); }
    waiters.clear();
    if (room) { try { await writeInvite('STOPPED'); } catch { /* Keep shutdown bounded. */ } }
    log('team-host.stopped', { reason }); finish();
  })();
  return stopPromise;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(signal); });

try {
  await mkdir(privateDir, { recursive: true });
  const session = await post('/api/session', { role: 'CAR_HOST', nickname: 'TEST SIMULATED TEAM HOST' });
  hostToken = session.token;
  invite = await post('/api/rooms', {}); roomId = invite.roomId; room = invite.room; lastInvite = Date.now();
  ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { handshakeTimeout: 8000 });
  ws.on('error', () => {});
  ws.on('message', bytes => {
    let message; try { message = JSON.parse(bytes); } catch { return; }
    if (message.type === 'snapshot') { room = message.room; settle('snapshot', message); }
    else if (message.type === 'auth.ok') settle('auth', message);
    else if (message.type === 'result') settle(message.commandId, message);
  });
  ws.once('close', () => {
    for (const pending of waiters.values()) { clearTimeout(pending.timer); pending.reject(new Error('WS_DISCONNECTED')); }
    waiters.clear();
    if (!stopping) { process.exitCode = 1; void stop('CONNECTION_LOST'); }
  });
  await new Promise((resolveOpen, reject) => { ws.once('open', resolveOpen); ws.once('error', () => reject(new Error('WS_CONNECT_FAILED'))); });
  const authenticated = Promise.all([wait('auth'), wait('snapshot')]);
  ws.send(JSON.stringify({ type: 'auth', token: hostToken, roomId })); await authenticated;
  await report(); await writeInvite();
  log('team-host.ready', { roomId, durationsec: seconds, autoStart: values['auto-start'], vehicleSignals: 'SIMULATED_NOT_SDK', phoneSeatsAvailable: 3 });
  interval = setInterval(() => { void tick().catch(() => { process.exitCode = 1; void stop('HOST_LOOP_FAILED'); }); }, 500);
  duration = setTimeout(() => { void stop('DURATION_COMPLETE'); }, seconds * 1000);
  await finished;
} catch (error) {
  process.exitCode = 1;
  log('team-host.error', { code: /^(HTTP_[0-9]+_[A-Z_]+|WS_[A-Z_]+)$/.test(error.message) ? error.message : 'SETUP_FAILED' });
  await stop('ERROR');
}
