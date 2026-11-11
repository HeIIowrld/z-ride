import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createQuizEngine } from '../shared/quiz-engine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png' };
const bank = JSON.parse(fs.readFileSync(path.join(root,'games/license-quiz/questions.json'),'utf8'));
const engines = new Map(), peers = new Set();
const send = (peer, message) => { if (!peer.socket.destroyed) peer.socket.write(frame(JSON.stringify(message))); };
function frame(text) { const data=Buffer.from(text), head=data.length<126?Buffer.from([0x81,data.length]):data.length<65536?Buffer.from([0x81,126,data.length>>8,data.length&255]):null; return head ? Buffer.concat([head,data]) : Buffer.alloc(0); }
function broadcast(session, message) { for (const peer of peers) if (peer.session===session) send(peer,message); }
function readBody(req) { return new Promise((resolve,reject)=>{ let body=''; req.on('data',chunk=>{body+=chunk;if(body.length>1_000_000)reject(new Error('body too large'));});req.on('end',()=>{try{resolve(JSON.parse(body||'{}'));}catch{reject(new Error('invalid JSON'));}});req.on('error',reject); }); }
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='POST' && url.pathname==='/api/trigger') { try { const event=await readBody(req), session=url.searchParams.get('session')||'default'; let engine=engines.get(session); if(!engine){engine=createQuizEngine({bank});engines.set(session,engine);} const q=engine.onTrigger(event); if(q)broadcast(session,{type:'question',questionId:q.id}); res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,questionId:q?.id||null})); } catch(error){res.writeHead(400);res.end(error.message);} return; }
  if(req.method==='POST' && ['/api/party/inventory','/api/records'].includes(url.pathname)) { try { const data=await readBody(req), dir=path.join(root,'server/data');fs.mkdirSync(dir,{recursive:true});const file=url.pathname.endsWith('records')?'records.jsonl':'inventory.jsonl';fs.appendFileSync(path.join(dir,file),JSON.stringify(data)+'\n','utf8');res.writeHead(201,{'content-type':'application/json'});res.end('{"ok":true}'); }catch(error){res.writeHead(400);res.end(error.message);}return; }
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end('Method not allowed');return;}
  let target=decodeURIComponent(url.pathname==='/ ' ? '/' : url.pathname);if(target==='/')target='/index.html';const file=path.resolve(root,'.'+target);if(!file.startsWith(root+path.sep)&&file!==root){res.writeHead(403);res.end('Forbidden');return;}fs.stat(file,(err,stat)=>{if(err||!stat.isFile()){res.writeHead(404);res.end('Not found');return;}res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream'});if(req.method==='HEAD')res.end();else fs.createReadStream(file).pipe(res);});
});
server.on('upgrade',(req,socket)=>{const url=new URL(req.url,'http://localhost');if(url.pathname!=='/vehicle'||!req.headers['sec-websocket-key']){socket.destroy();return;}const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');const peer={socket,session:url.searchParams.get('session')||'default'};peers.add(peer);socket.on('data',buffer=>{try{let offset=2,len=buffer[1]&127;if(len===126){len=buffer.readUInt16BE(2);offset=4;}const masked=!!(buffer[1]&128),mask=masked?buffer.subarray(offset,offset+4):null;offset+=masked?4:0;let data=buffer.subarray(offset,offset+len);if(mask){data=Buffer.from(data);for(let i=0;i<data.length;i++)data[i]^=mask[i%4];}const message=JSON.parse(data.toString());if(message.type==='trigger'&&message.event){broadcast(peer.session,message);const engine=engines.get(peer.session)||createQuizEngine({bank});engines.set(peer.session,engine);const q=engine.onTrigger(message.event);if(q)broadcast(peer.session,{type:'question',questionId:q.id});}else broadcast(peer.session,message);}catch{/* Ignore malformed frames. */}});socket.on('close',()=>peers.delete(peer));socket.on('error',()=>peers.delete(peer));});
const port=Number(process.env.PORT)||8787;server.listen(port,'0.0.0.0',()=>console.log(`Quiz server listening on http://localhost:${port}`));
