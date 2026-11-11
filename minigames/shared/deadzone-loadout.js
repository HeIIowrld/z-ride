import { readFile } from 'node:fs/promises';
const items=JSON.parse(await readFile(new URL('../data/items.json',import.meta.url),'utf8'));
const byId=new Map(items.map(x=>[x.id,x]));
const caps={shieldBonus:40,moveSpeed:1.12,dashExtra:1,thorns:30,knock:1.35,magnet:1.7,slowAura:5,pierce:1};
const addKeys=new Set(['shieldBonus','dashExtra','thorns','slowAura','pierce']);
function ownCounts(party){const raw=party?.inventory||party?.items||party||{};return raw instanceof Map?Object.fromEntries(raw):Array.isArray(raw)?Object.fromEntries(raw.map(x=>[x.itemId||x.id,Number(x.qty)||0])):raw;}
export function buildDeadzoneLoadout(party={},conditions={}){
 const counts=ownCounts(party), eq=party.equipment||party.gear||{}; let ownedGear=[];
 if(Array.isArray(eq)) ownedGear=eq.map(x=>typeof x==='string'?x:x.itemId).filter(Boolean);
 else if(typeof eq==='object') ownedGear=Object.values(eq).filter(Boolean);
 const gear=ownedGear.map(id=>byId.get(id)).filter(x=>x?.category==='gear');
 const mods={}; const put=(key,val)=>{if(addKeys.has(key))mods[key]=Math.min(caps[key],(mods[key]||0)+val);else if(key==='moveSpeed'||key==='knock'||key==='magnet')mods[key]=Math.min(caps[key],(mods[key]||1)*val);};
 let weapons=[],ability=null,skin=null;
 const apply=(effect)=>{for(const [k,v] of Object.entries(effect||{}))if(caps[k]!=null)put(k,v);if(effect?.startWeapon&&!weapons.includes(effect.startWeapon)&&weapons.length<2)weapons.push(effect.startWeapon);if(effect?.startAbility&&!ability)ability=effect.startAbility;if(effect?.skin)skin=effect.skin;};
 for(const item of gear){apply(item.deadzone);if(conditions.night)apply(item.deadzone?.nightMods);if(conditions.rain)apply(item.deadzone?.rainMods);}
 for(const item of items)if((Number(counts[item.id])||0)>0&&item.category!=='gear')apply(item.deadzone);for(const item of items.filter(x=>x.category==='weapon'))if((Number(counts[item.id])||0)>0&&weapons.length<2)apply(item.deadzone);
 const kinds=['medkit','surge','bubble','shieldRefill'],limit=Math.min(6,Math.round(Math.max(1,Math.min(4,Number(party.players)||1))*1.5)),consumables=Object.fromEntries(kinds.map(k=>[k,0]));
 for(const item of items.filter(x=>x.category==='consumable')){const k=item.deadzone?.kind;if(k&&consumables[k]!=null)consumables[k]=Math.min(limit,consumables[k]+Math.max(0,Number(counts[item.id])||0));}
 const parts=items.filter(x=>x.category==='part').reduce((n,x)=>n+Math.max(0,Number(counts[x.id])||0),0);
 return {schema:'zride.deadzone-loadout.v1',partyId:String(party.partyId||party.id||''),conditions:{night:!!conditions.night,rain:!!conditions.rain},mods,startWeapons:weapons,startAbility:ability,consumables,startCredits:Math.min(40,Math.floor(parts/5)*10),skin,gear:gear.map(x=>({slot:x.slot,itemId:x.id,name:x.name}))};
}
export { caps as DEADZONE_MOD_CAPS };
