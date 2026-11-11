import { SERVER_URL, CLIENT_VERSION } from './config.js';
const KEY = 'zride.records', queue = [];
function read() { try { const value = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } }
function uuid() { return globalThis.crypto?.randomUUID?.() || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function playerId() { try { let id = localStorage.getItem('zride.playerId'); if (!id) { id = uuid(); localStorage.setItem('zride.playerId', id); } return id; } catch { return 'anonymous'; } }
async function flush() {
  if (!SERVER_URL || !queue.length) return;
  while (queue.length) { try { const response = await fetch(`${SERVER_URL}/api/records`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(queue[0]) }); if (!response.ok) break; queue.shift(); } catch { break; } }
  if (queue.length) setTimeout(flush, 5000);
}
export function saveRecord(record) {
  let lootSummary={visitedRegions:0,total:0,byRarity:{},regionalCollected:0,codexCompletion:0};
  try { const inv=JSON.parse(localStorage.getItem('zride.inventory')||'{}'),events=JSON.parse(localStorage.getItem('zride.loot.events')||'[]'),catalog=JSON.parse(localStorage.getItem('zride.items.catalog')||'[]'),regional=catalog.filter(x=>x.rarity==='regional');lootSummary.total=Object.values(inv).reduce((n,q)=>n+(Number(q)||0),0);lootSummary.visitedRegions=new Set(events.map(e=>e.region).filter(Boolean)).size;for(const [id,q] of Object.entries(inv)){const rarity=catalog.find(x=>x.id===id)?.rarity||'common';lootSummary.byRarity[rarity]=(lootSummary.byRarity[rarity]||0)+Number(q||0);}lootSummary.regionalCollected=regional.filter(x=>Number(inv[x.id])>0).length;lootSummary.codexCompletion=regional.length?lootSummary.regionalCollected/regional.length:0; } catch { /* Loot summary is optional. */ }
  const full = { id: uuid(), gameId: String(record.gameId), playerId: playerId(), partyId: record.partyId ?? null,
    score: Number(record.score) || 0, durationMs: Number(record.durationMs) || 0, distanceM: Number(record.distanceM) || 0,
    stats: record.stats || {}, lootSummary: record.lootSummary || lootSummary, endReason: record.endReason || 'unknown', createdAt: new Date().toISOString(), clientVersion: CLIENT_VERSION };
  const records = read(); records.push(full);
  try { localStorage.setItem(KEY, JSON.stringify(records.slice(-500))); } catch { /* Records remain available for this session. */ }
  if (SERVER_URL) { queue.push(full); flush(); }
  return full;
}
export function getRecords(gameId) { return read().filter(record => record.gameId === gameId).sort((a, b) => b.score - a.score || a.durationMs - b.durationMs); }
export function getBest(gameId, filterFn) { return getRecords(gameId).filter(record => !filterFn || filterFn(record)).sort((a,b)=>b.score-a.score||a.durationMs-b.durationMs)[0] || null; }
