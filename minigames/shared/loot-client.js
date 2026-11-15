import { SERVER_URL } from './config.js';
import { inRouteSign } from './journey.js';
import { createLootEngine } from './loot-engine.js';
import { itemBadge, itemScope, scopeLabel } from './item-icons.js';
const itemsPromise=fetch(new URL('../data/items.json',import.meta.url)).then(async r=>{const rows=await r.json();try{localStorage.setItem('zride.items.catalog',JSON.stringify(rows));}catch{}return rows;}),tablesPromise=fetch(new URL('../data/loot_tables.json',import.meta.url)).then(r=>r.json()),pointsPromise=fetch(new URL('../data/points.json',import.meta.url)).then(r=>r.json());
const KEY='zride.loot.state', PARTY='zride.partyId';let enginePromise;
export function partyId(){try{let id=localStorage.getItem(PARTY);if(!id){id=globalThis.crypto?.randomUUID?.()||`party-${Date.now()}`;localStorage.setItem(PARTY,id);}return id;}catch{return 'local-party';}}
export async function getLootEngine(){if(!enginePromise)enginePromise=Promise.all([itemsPromise,tablesPromise,pointsPromise]).then(([items,tables,points])=>{let initialState={};try{initialState=JSON.parse(localStorage.getItem('zride.loot.engine')||'{}');}catch{}return createLootEngine({items,tables,points,initialState});});return enginePromise;}
function collectTickOutput(out,at){for(const event of out.events||[])for(const item of event.items||[]){try{const inv=JSON.parse(localStorage.getItem('zride.inventory')||'{}');inv[item.id]=(Number(inv[item.id])||0)+1;localStorage.setItem('zride.inventory',JSON.stringify(inv));}catch{}saveLootEvent({...event,item,at:new Date(at).toISOString(),region:out.region});notifyLoot(item);}}
export async function reportTick(input){const body={...input,partyId:input.partyId||partyId()},at=body.at||Date.now();if(SERVER_URL){const r=await fetch(`${SERVER_URL}/loot/tick`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(r.ok){const out=await r.json();collectTickOutput(out,at);return out;}}const engine=await getLootEngine(),out=engine.tick(body);try{localStorage.setItem(KEY,JSON.stringify(out));localStorage.setItem('zride.loot.engine',JSON.stringify(engine.snapshot()));}catch{}collectTickOutput(out,at);return out;}
export async function requestMinigame(gameId,result={}){const party=partyId();if(SERVER_URL){const r=await fetch(`${SERVER_URL}/loot/minigame`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({partyId:party,gameId,result})});if(r.ok)return r.json();}const engine=await getLootEngine(),out=engine.minigame({partyId:party,gameId,result});return out;}
// 여정(폰 앱) 안에서 실행 중이면 결과를 부모 화면에 보낸다. 경로 표지판 도전 중이면 서버가 보상을 지급한다.
function journeyReward(gameId,result){
  if(typeof window==='undefined'||window.parent===window||!location.pathname.includes('/drive/games/'))return Promise.resolve(null);
  const requestId=globalThis.crypto?.randomUUID?.()||String(Date.now()+Math.random());
  return new Promise(resolve=>{
    const done=value=>{clearTimeout(timer);window.removeEventListener('message',listen);resolve(value);};
    const listen=event=>{if(event.source===window.parent&&event.origin===location.origin&&event.data?.type==='zride:drive-reward'&&event.data.requestId===requestId)done(event.data);};
    const timer=setTimeout(()=>done(null),inRouteSign ? 25000 : 12000);
    window.addEventListener('message',listen);
    window.parent.postMessage({type:'zride:drive-result',requestId,gameId,score:Number(result?.score)||0},location.origin);
  });
}
export async function awardMinigame(gameId, result = {}) {
  const journey = await journeyReward(gameId, result);
  if (inRouteSign || journey?.handled) {
    return { type: 'route-sign', items: journey?.items ?? [], error: journey?.error ?? (!journey ? 'SIGN_RESPONSE_TIMEOUT' : undefined) };
  }
  const out = await requestMinigame(gameId, result);
  for (const item of out.items ?? []) {
    try {
      const inv = JSON.parse(localStorage.getItem('zride.inventory') || '{}');
      inv[item.id] = (Number(inv[item.id]) || 0) + 1;
      localStorage.setItem('zride.inventory', JSON.stringify(inv));
    } catch {}
    notifyLoot(item);
    saveLootEvent({ type: 'minigame', source: gameId, item, at: new Date().toISOString() });
  }
  return out;
}
export function readLootEvents(){try{return JSON.parse(localStorage.getItem('zride.loot.events')||'[]');}catch{return[];}}
export function saveLootEvent(event){try{const events=readLootEvents();events.push(event);localStorage.setItem('zride.loot.events',JSON.stringify(events.slice(-500)));}catch{}}
let lootToastTimer;
export function notifyLoot(item) {
  if (!item) return;
  let node = document.querySelector('#loot-toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'loot-toast';
    node.className = 'loot-toast item-inline';
    node.setAttribute('role', 'status');
    document.body.append(node);
  }
  node.replaceChildren(itemBadge(item), `${item.name} · ${scopeLabel(itemScope(item))}`);
  node.classList.add('show');
  navigator.vibrate?.(80);
  clearTimeout(lootToastTimer);
  lootToastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

export async function presentMinigameReward(container, gameId, result) {
  container.textContent = '보상 확인 중…';
  container.dataset.state = 'pending';
  container.hidden = false;
  let reward;
  try { reward = await awardMinigame(gameId, result); }
  catch { reward = { error: 'SIGN_RESPONSE_TIMEOUT' }; }
  const names = (reward.items ?? []).map(item => item.name);
  container.dataset.state = names.length ? 'earned' : 'complete';
  container.textContent = names.length ? `획득 · ${names.join(' · ')}`
    : reward.error === 'SIGN_GOAL_NOT_MET' ? '1점 이상 획득하면 전용 보상을 받을 수 있어요.'
    : reward.error ? '보상을 확인하지 못했어요. 지도에서 크루 가방을 확인하세요.'
    : '이번 플레이에서 획득한 아이템이 없어요.';
  return reward;
}
