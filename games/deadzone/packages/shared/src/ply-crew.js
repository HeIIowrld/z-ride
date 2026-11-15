export const validCrewKey = value => typeof value === 'string' && /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/.test(value);

export async function crewItems(env, crewKey, game, code, action, details = {}) {
  const url = new URL('/api/game-items', env.PLY_ITEMS_ORIGIN || 'https://hyundai.hjpark.net');
  const init = {
    method: 'POST', redirect: 'manual',
    headers: { authorization: 'Bearer ' + crewKey, 'content-type': 'application/json' },
    body: JSON.stringify({ game, code, action, ...details }),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(2200) });
      if (response.ok) return await response.json();
      if (response.status < 500) {
        const { error } = await response.json();
        throw Object.assign(new Error(error?.code ?? 'GAME_ITEMS_UNAVAILABLE'), { permanent: true });
      }
    } catch (error) {
      if (error.permanent) throw error;
    }
  }
  throw new Error('GAME_ITEMS_UNAVAILABLE');
}
