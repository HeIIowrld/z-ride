export const TRIGGER_PRIORITY = ['tbt', 'caution', 'camera', 'speedLimit', 'wiper', 'turnSignal', 'night', 'idle'];
const GAP_MS = 60_000, IDLE_MS = 300_000;
const triggerKey = event => event.type === 'tbt' ? `tbt:${event.detail?.turn}` : event.type === 'caution' || event.type === 'camera' ? `${event.type}:${event.detail?.kind}` : event.type;

export function createQuizEngine({ bank = [], now = () => Date.now(), rng = Math.random } = {}) {
  const used = new Set(); let lastAskedAt = null, lastTriggerAt = now(), lastAcceptedPriority = -1;
  let asked = 0, correct = 0, combo = 0, maxCombo = 0, responseMs = 0;
  const byType = {}, wrongIds = [];
  function choose(event) {
    const key = event.type === 'practice' ? 'idle' : triggerKey(event); let candidates = bank.filter(q => q.trigger === key && !used.has(q.id));
    if (!candidates.length && event.type === 'tbt') candidates = bank.filter(q => q.trigger === 'tbt:right' && !used.has(q.id));
    if (!candidates.length && event.type === 'camera') candidates = bank.filter(q => q.trigger === 'camera:section' && !used.has(q.id));
    if (!candidates.length && event.type === 'speedLimit') candidates = bank.filter(q => q.trigger === 'idle' && !used.has(q.id));
    if (!candidates.length) return null;
    let pool = candidates;
    if (asked < 5) { const signs = pool.filter(q => q.type === 'sign'); if (signs.length) pool = signs; }
    else if (asked > 0 && correct / asked >= .7) { const adaptive = pool.filter(q => ['situation', 'weather_time'].includes(q.type)); if (adaptive.length) pool = adaptive; }
    return pool[Math.floor(Math.max(0, Math.min(.999999, rng())) * pool.length)];
  }
  function onTrigger(event, { ignoreGap = false } = {}) {
    if (!event || typeof event.type !== 'string') return null;
    const at = Number.isFinite(event.at) ? event.at : now();
    if (event.type === 'idle' && at - lastTriggerAt < IDLE_MS) return null;
    if (event.type !== 'idle') lastTriggerAt = at;
    const priority = TRIGGER_PRIORITY.indexOf(event.type);
    if (!ignoreGap && lastAskedAt !== null && at - lastAskedAt < GAP_MS) return null;
    if (priority >= 0 && lastAcceptedPriority >= 0 && priority > lastAcceptedPriority && at === lastAskedAt) return null;
    const q = choose(event); if (!q) return null;
    used.add(q.id); lastAskedAt = at; lastTriggerAt = at; lastAcceptedPriority = priority;
    asked++; byType[q.type] ||= { asked: 0, correct: 0 }; byType[q.type].asked++;
    return q;
  }
  function answer(questionId, choiceIndex, elapsedMs = 0) {
    const q = bank.find(item => item.id === questionId); if (!q || !Number.isInteger(choiceIndex)) return null;
    const ok = choiceIndex === q.answer; responseMs += Math.max(0, elapsedMs); if (ok) { correct++; combo++; maxCombo = Math.max(maxCombo, combo); (byType[q.type] ||= { asked: 0, correct: 0 }).correct++; } else { combo = 0; wrongIds.push(q.id); }
    return { correct: ok, question: q, score: ok ? Math.round((10 + (elapsedMs <= 5000 ? 5 : 0)) * Math.min(2.5, 1 + Math.floor(combo / 3) * .5)) : 0, combo, asked, correctCount: correct };
  }
  function summary() { return { asked, correct, combo, maxCombo, avgResponseMs: asked ? Math.round(responseMs / asked) : 0, byType: Object.fromEntries(Object.entries(byType).map(([k,v]) => [k, { ...v, accuracy: v.asked ? v.correct / v.asked : 0 }])), wrongIds: [...wrongIds], lastAskedAt }; }
  return { onTrigger, answer, summary, get lastAskedAt() { return lastAskedAt; }, get used() { return new Set(used); } };
}
