/** Isolated benchmark wrapper. Never point at production state or publish this port. */
import http from 'node:http';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { statSync } from 'node:fs';
import { createDemoServer } from '../server.mjs';
const name=process.env.BENCH_CASE??'baseline';
if(!/^[a-z0-9-]{1,64}$/.test(name))throw new Error('Invalid case');
const db=process.env.BENCH_STATE_DIR+'/'+name+'.sqlite';
if(!process.env.BENCH_STATE_DIR)throw new Error('Dedicated benchmark directory required');
const app=createDemoServer({dbPath:db,placesPath:process.env.ZRIDE_PLACES_PATH,publicOrigin:'http://benchmark.invalid'});
const lag=monitorEventLoopDelay({resolution:20});lag.enable();
let requests=0,failures=0,started=performance.now(),cpu=process.cpuUsage(),elu=performance.eventLoopUtilization();
app.server.on('request',(_req,res)=>res.once('finish',()=>{requests++;if(res.statusCode>=400)failures++;}));
const metrics=http.createServer((req,res)=>{
  const used=process.cpuUsage(cpu),seconds=(performance.now()-started)/1000;
  const value={case:name,elapsedSec:seconds,requests,httpFailures:failures,cpuPercent:(used.user+used.system)/10000/Math.max(seconds,.001),rssMiB:process.memoryUsage().rss/1048576,eventLoopUtilization:performance.eventLoopUtilization(elu).utilization,lagP95Ms:lag.percentile(95)/1e6,lagMaxMs:lag.max/1e6,dbBytes:[db,db+'-wal'].reduce((sum,p)=>{try{return sum+statSync(p).size;}catch{return sum;}},0)};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
  if(req.url==='/reset'){requests=0;failures=0;started=performance.now();cpu=process.cpuUsage();elu=performance.eventLoopUtilization();lag.reset();}
});
await app.listen(18080,'0.0.0.0');await new Promise(r=>metrics.listen(18081,'0.0.0.0',r));
console.log(JSON.stringify({ready:true,case:name}));
process.on('SIGTERM',async()=>{lag.disable();metrics.close();await app.close();process.exit(0);});
