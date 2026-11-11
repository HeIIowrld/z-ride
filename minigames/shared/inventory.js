import { SERVER_URL } from './config.js';
import { partyId } from './loot-client.js';
let catalog=[];try{catalog=await fetch(new URL('../data/items.json',import.meta.url)).then(r=>r.ok?r.json():[]);}catch{/* Offline catalog remains optional in non-browser contexts. */}
export const ITEMS=Object.freeze({part:{name:'정비 부품',type:'material'},turret:{name:'보조 포탑',type:'equipment'},supply:{name:'보급품',type:'material'},coolant:{name:'냉각수',type:'material'},ammo:{name:'탄약 상자',type:'material'},medkit:{name:'의료 키트',type:'material'},...Object.fromEntries(catalog.map(item=>[item.id,{...item,type:item.category}]))});
const KEY='zride.inventory',listeners=new Set(),queue=[];
function read(){try{return JSON.parse(localStorage.getItem(KEY)||'{}')||{};}catch{return {};}}
function write(value){try{localStorage.setItem(KEY,JSON.stringify(value));}catch{/* Offline storage is optional. */}}
async function flush(){if(!SERVER_URL||!queue.length)return;while(queue.length){try{const r=await fetch(`${SERVER_URL}/api/party/inventory`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(queue[0])});if(!r.ok)break;queue.shift();}catch{break;}}if(queue.length)setTimeout(flush,5000);}
export function getInventory(){return read();}
export function onChange(callback){listeners.add(callback);return()=>listeners.delete(callback);}
export function addItem(id,qty=1,meta={}){if(!ITEMS[id]||!Number.isFinite(qty)||qty<=0)return getInventory();const inventory=read();inventory[id]=(Number(inventory[id])||0)+qty;write(inventory);const delta={id,qty,meta,partyId:partyId(),createdAt:new Date().toISOString()};if(SERVER_URL){queue.push(delta);flush();}for(const callback of listeners){try{callback(inventory,delta);}catch(error){console.error(error);}}return inventory;}
