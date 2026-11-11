import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const dir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'data');fs.mkdirSync(dir,{recursive:true});
export const db=new DatabaseSync(path.join(dir,'zride.db'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS parties(id TEXT PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS inventory(party_id TEXT NOT NULL,item_id TEXT NOT NULL,qty INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(party_id,item_id));
CREATE TABLE IF NOT EXISTS loot_log(id INTEGER PRIMARY KEY,party_id TEXT,item_id TEXT,at TEXT,lat2 REAL,lng2 REAL,region TEXT,source TEXT);
CREATE TABLE IF NOT EXISTS equipment(party_id TEXT,slot TEXT,item_id TEXT,PRIMARY KEY(party_id,slot));
CREATE TABLE IF NOT EXISTS party_state(party_id TEXT PRIMARY KEY,region TEXT,km_in_region REAL DEFAULT 0,last_lat REAL,last_lng REAL,last_at INTEGER,gear TEXT,boxes_this_hour INTEGER DEFAULT 0,hour_start INTEGER,pending_boxes INTEGER DEFAULT 0,odometer_km REAL,visited TEXT DEFAULT '[]');`);
export function ensureParty(id){db.prepare('INSERT OR IGNORE INTO parties(id) VALUES(?)').run(String(id));}
export function addInventory(party,item,qty=1){ensureParty(party);db.prepare('INSERT INTO inventory VALUES(?,?,?) ON CONFLICT(party_id,item_id) DO UPDATE SET qty=qty+excluded.qty').run(String(party),item,qty);}
export function inventoryFor(party){return db.prepare('SELECT item_id AS itemId,qty FROM inventory WHERE party_id=? ORDER BY item_id').all(String(party));}
export function stateFor(party){return db.prepare('SELECT * FROM party_state WHERE party_id=?').get(String(party));}
export function saveTick(party,s,result,input){ensureParty(party);db.prepare(`INSERT INTO party_state(party_id,region,km_in_region,last_lat,last_lng,last_at,gear,boxes_this_hour,hour_start,pending_boxes,odometer_km,visited) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(party_id) DO UPDATE SET region=excluded.region,km_in_region=excluded.km_in_region,last_lat=excluded.last_lat,last_lng=excluded.last_lng,last_at=excluded.last_at,gear=excluded.gear,boxes_this_hour=excluded.boxes_this_hour,hour_start=excluded.hour_start,pending_boxes=excluded.pending_boxes,odometer_km=excluded.odometer_km,visited=excluded.visited`).run(String(party),s.region,s.km,Math.round(input.lat*100)/100,Math.round(input.lng*100)/100,input.at,input.gear??s.gear,s.boxes,s.hourStart,s.pending,s.lastOdometer,JSON.stringify(s.visited));for(const event of result.events)for(const item of event.items){addInventory(party,item.id);db.prepare('INSERT INTO loot_log(party_id,item_id,at,lat2,lng2,region,source) VALUES(?,?,?,?,?,?,?)').run(String(party),item.id,new Date(input.at).toISOString(),Math.round(input.lat*100)/100,Math.round(input.lng*100)/100,event.region||s.region,event.type);}}

export function consumeInventory(party,items,source='deadzone',roomCode=null){ensureParty(party);const take=db.prepare('UPDATE inventory SET qty=MAX(0,qty-?) WHERE party_id=? AND item_id=?');const log=db.prepare('INSERT INTO loot_log(party_id,item_id,at,region,source) VALUES(?,?,?,?,?)');const results={};for(const [item,raw] of Object.entries(items||{})){const requested=Math.max(0,Math.floor(Number(raw)||0));const row=db.prepare('SELECT qty FROM inventory WHERE party_id=? AND item_id=?').get(String(party),item);const used=Math.min(requested,Math.max(0,row?.qty||0));if(used)take.run(used,String(party),item);for(let i=0;i<used;i++)log.run(String(party),item,new Date().toISOString(),null,source+(roomCode?':'+roomCode:''));results[item]=used;}return results;}
