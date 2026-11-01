import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const { values } = parseArgs({ options: {
  base: { type: 'string', default: 'http://127.0.0.1:8000' },
  durationsec: { type: 'string', default: '0' },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('node tools/demo-party.mjs --base http://127.0.0.1:8001 [--durationsec 30]');
  console.log('Creates a NEW explicitly simulated TEST party through real REST/WS. No tokens are printed.');
  process.exit(0);
}
const baseUrl = new URL(values.base);
if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || !['', '/'].includes(baseUrl.pathname)) throw new Error('--base must be a plain HTTP(S) origin');
const base = baseUrl.origin;
const seconds = Number(values.durationsec);
if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 86400) throw new Error('--durationsec must be 0..86400; 0 waits for SIGINT');
const wsBase = base.replace(/^http/, 'ws') + '/ws';
const clients = [];
let heartbeat, duration, stopping = false, reportBusy = false, reportSeq = 0;
let finish;
const finished = new Promise(resolve => { finish = resolve; });
const log = (event, detail = {}) => console.log(JSON.stringify({ event, simulated: true, source: 'SIMULATED_API_CLIENTS', ...detail }));

async function post(path, body, credential) {
  const response = await fetch(base + path, {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { 'content-type': 'application/json', ...(credential ? { authorization: 'Bearer ' + credential } : {}) },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + (value.error?.code ?? 'UNKNOWN_ERROR'));
  return value;
}
async function connect(credential, roomId, role) {
  const ws = new WebSocket(wsBase, { handshakeTimeout: 8000 });
  const waiters = new Map();
  let room = null;
  const wait = key => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(key); reject(new Error('WS_RESPONSE_TIMEOUT')); }, 8000);
    waiters.set(key, { resolve, reject, timer });
  });
  const settle = (key, value) => {
    const pending = waiters.get(key);
    if (pending) { waiters.delete(key); clearTimeout(pending.timer); pending.resolve(value); }
  };
  ws.on('message', bytes => {
    let value; try { value = JSON.parse(bytes); } catch { return; }
    if (value.type === 'snapshot') { room = value.room; settle('first-snapshot', value); }
    else if (value.type === 'auth.ok') settle('auth', value);
    else if (value.type === 'result') settle(value.commandId, value);
  });
  const rejectPending = () => {
    for (const pending of waiters.values()) { clearTimeout(pending.timer); pending.reject(new Error('WS_CONNECTION_CLOSED')); }
    waiters.clear();
  };
  ws.on('error', () => {});
  ws.on('close', () => {
    rejectPending();
    if (!stopping) { log('demo.connection-lost', { role }); process.exitCode = 1; stop('CONNECTION_LOST'); }
  });
  const client = { ws, role, get room() { return room; }, async send(message) {
    if (ws.readyState !== WebSocket.OPEN) throw new Error('WS_CONNECTION_CLOSED');
    const result = wait(message.commandId); ws.send(JSON.stringify(message));
    const response = await result;
    if (!response.ok) throw new Error('WS ' + (response.error?.code ?? 'UNKNOWN_ERROR'));
    return response;
  } };
  clients.push(client);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', () => reject(new Error('WS_CONNECTION_FAILED'))); });
  const authenticated = wait('auth'), snapshot = wait('first-snapshot');
  // Consume both promises even if authentication fails and the socket closes.
  const connected = Promise.all([authenticated, snapshot]);
  ws.send(JSON.stringify({ type: 'auth', token: credential, roomId })); await connected;
  return client;
}
function stop(reason) {
  if (stopping) return;
  stopping = true; clearInterval(heartbeat); clearTimeout(duration);
  for (const client of clients) client.ws.terminate();
  log('demo.stopped', { reason }); finish();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(signal));
const command = (client, action, detail = {}) => client.send({ type: 'command', commandId: randomUUID(), roomEpoch: client.room.roomEpoch, action, ...detail });

try {
  const hostSession = await post('/api/session', { role: 'CAR_HOST', nickname: 'TEST CAR HOST' });
  let created = await post('/api/rooms', {}, hostSession.token);
  const roomId = created.roomId;
  const host = await connect(hostSession.token, roomId, 'CAR_HOST');
  const report = () => host.send({ type: 'vehicle.report', commandId: randomUUID(), reportSeq: ++reportSeq,
    ux: 'ALLOWED', gear: 'P', foreground: true,
    seats: ['FRONT_PASSENGER', 'REAR_LEFT', 'REAR_RIGHT'].map(seat => ({ seat, occupancy: 'UNKNOWN' })),
    source: 'SIMULATED_API_CLIENTS', charge: { state: 'UNKNOWN', portConnection: 'UNKNOWN', source: 'SIMULATED_API_CLIENTS' } });
  await report();
  heartbeat = setInterval(async () => {
    if (stopping || reportBusy) return;
    reportBusy = true;
    try { await report(); }
    catch { if (!stopping) { process.exitCode = 1; stop('REPORT_FAILED'); } }
    finally { reportBusy = false; }
  }, 2000);
  const phones = [];
  const seats = ['FRONT_PASSENGER', 'REAR_LEFT', 'REAR_RIGHT'];
  for (const [index, seat] of seats.entries()) {
    if (stopping) break;
    if (index > 0) created = await post('/api/rooms', {}, hostSession.token);
    const session = await post('/api/session', { role: 'PHONE', nickname: 'TEST ' + seat });
    const joined = await post('/api/join', { joinCode: created.joinCode, seat }, session.token);
    await post('/api/rooms/' + roomId + '/approve', { memberId: joined.memberId, seat, allowManualUnknown: true }, hostSession.token);
    phones.push(await connect(session.token, roomId, seat));
  }
  if (!stopping) {
    await command(host, 'round.start');
    for (const phone of phones) await command(phone, 'mobile.collect', { pickupId: 'DEMO_PICKUP_A', passengerConfirmed: true });
    await command(host, 'support.pulse');
    for (const [index, phone] of phones.entries()) await command(phone, 'fire', { angleDeg: [60, -100, 140][index] });
    log('demo.ready', { roomId, participants: 4, state: host.room.state,
      members: ['TEST CAR HOST', ...seats.map(seat => 'TEST ' + seat)],
      durationsec: seconds, collectionMode: 'DEMO_PICKUP_GPS_UNVERIFIED', vehicleSignals: 'SIMULATED_NOT_SDK' });
    if (seconds > 0) duration = setTimeout(() => stop('DURATION_COMPLETE'), seconds * 1000);
    await finished;
  }
} catch (error) {
  process.exitCode = 1;
  // Only controlled status/error codes; never dump request objects, sessions or credentials.
  log('demo.error', { message: /^(HTTP |WS[_ ]|--)/.test(error.message) ? error.message : 'DEMO_SETUP_FAILED' });
  stop('ERROR');
}
