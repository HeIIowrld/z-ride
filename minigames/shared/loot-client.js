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
