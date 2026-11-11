// Z-RIDE adaptation, 2026-11-06. New code: Apache-2.0.
export function partySize(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new RangeError('인원은 1~4명이어야 합니다.');
  return n;
}
export function difficultyFor(value) {
  const players = partySize(value);
  return { players, spawnMultiplier: +(1 + (players - 1) * 0.72).toFixed(2), label: ['생존자', '듀오', '스쿼드', '풀 스쿼드'][players - 1] };
}
export function dashboardSnapshot(room, sim, roster, now = Date.now()) {
  const targetPlayers = room.targetPlayers || 4;
  const snapshot = sim?.snapshot();
  const players = roster.map(r => {
    const p = sim?.playerById(r.id);
    return { id: r.id, name: r.name, ready: r.ready, connected: r.connected, bot: r.bot,
      hp: p ? Math.round(p.hp) : null, maxHp: p ? p.maxHp : null,
      shield: p ? Math.round(p.shield) : null, down: !!p?.down,
      alive: p ? !!p.alive : null, kills: p?.kills || 0, score: Math.round(p?.score || 0),
      x: p?.x ?? 0, z: p?.z ?? 0 };
  });
  return { schema: 'zride.dashboard.v1', game: 'deadzone', roomCode: room.code,
    state: room.state, targetPlayers, difficulty: difficultyFor(targetPlayers),
    connectedPlayers: players.filter(p => p.connected).length,
    wave: snapshot?.wave || 0, elapsed: snapshot?.matchTime || 0,
    phase: snapshot?.phase || 'waiting', teamScore: players.reduce((s,p) => s+p.score,0),
    kills: players.reduce((s,p) => s+p.kills,0), players,
    enemies: (snapshot?.enemies || []).map(e => ({x:e.x,z:e.z,kind:e.k})),
    pickups: snapshot?.pickups || [], arenaRadius: sim?.arenaRadius || 46,
    vehicle: sim?.sharedVehicle ? { hp: Math.ceil(sim.sharedVehicle.hp), maxHp: sim.sharedVehicle.maxHp, repairedWave: sim.sharedVehicle.repairedWave ?? null }
      : { source: 'unconnected', parked: null, controlsEnabled: false },
    runId: room.runId ?? null,
    timestamp: now };
}
