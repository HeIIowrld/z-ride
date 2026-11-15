import { inJourney, inRouteSign, crewHasItem, notifyJourneyReady, returnToJourney } from '../../shared/journey.js';
import { createVehicleFeed } from '../../shared/vehicle.js';
import { getSeat } from '../../shared/seat.js';
import { addItem,getInventory } from '../../shared/inventory.js';
import { presentMinigameReward } from '../../shared/loot-client.js';
import { startLootTracking } from '../../shared/loot-tracker.js';
startLootTracking();
import { getBest,saveRecord } from '../../shared/records.js';
import { ensurePassenger } from '../../shared/passenger.js';
import { hatchRect } from '../../shared/sketch.js';
import { createScenery } from '../../shared/scenery.js';
import { drawWindowFrame } from '../../shared/window-frame.js';
import { pointInWindow,traceWindow,windowPolygon } from '../../shared/window-frame.js';
import { mountDoorHud, findLayoutOverlaps } from '../../shared/door-hud.js';
import { travelDir, frontEdgeX, rearEdgeX } from '../../shared/motion.js';
const scenery=createScenery({seed:17});
const sceneOverride=new URLSearchParams(location.search).get('scene');
if(sceneOverride) scenery.setTimeOfDay(sceneOverride);
const canvas=document.querySelector('#game'),ctx=canvas.getContext('2d'),$=id=>document.getElementById(id),params=new URLSearchParams(location.search),dev=params.get('dev')==='1';
let sharpCanvas,sharpCtx,softCanvas,softCtx,sampleCanvas,sampleCtx,samplePixels,grain=[];
let w=0,h=0,dpr=1,barWidth=0,barWideUntil=0,powerups=[],dust=[],kingActive=false,feed,active=false,ended=false,last=0,startAt=0,speed=40,smoothSpeed=speed,previousSmoothSpeed=speed,vehicleAccel=0,ramp={target:null,elapsed:0,start:0},wiper=null,mode='practice',drops=[],streaks=[],score=0,combo=0,maxCombo=0,caught=0,missed=0,biggest=0,coolant=0,highCatches=0,overflow=0,catcherX=0,targetX=0,spawn=0,windKmh=0,muted=false,audio,toastTimer,spawnScale=1,eventNow=null,eventUntil=0,nextEvent=0,eventSide=1,flashUntil=0,comboUntil=0,comboPop='',scorePops=[];
const catcherHalfWidth=()=>(performance.now()<barWideUntil?barWidth*.8:barWidth/2)+(crewHasItem('wide-catcher')?12:0);
const inventory=()=>inRouteSign ? 0 : Number(getInventory().coolant)||0;
function devSpeedRamp(delta){const from=speed,to=Math.max(0,from+delta),started=performance.now();const tick=setInterval(()=>{const t=Math.min(1,(performance.now()-started)/1200);speed=from+(to-from)*t;if(t>=1)clearInterval(tick)},30)}
const doorHud=mountDoorHud(document.querySelector('.rain-stage'),{game:'raindrop',controls:[{id:'drop',icon:'drop',label:'톡 떨어뜨리기',primary:true}],items:[{id:'coolant',count:0},{id:'medkit',count:0},{id:'badge-seoul',count:0}]});window.__layoutCheck=()=>findLayoutOverlaps(document.querySelector('.rain-stage'),'.door-hud,#toast');
window.__raindrop={getState:()=>({dropCount:drops.length,stuck:drops.filter(d=>d.state==='stuck').length,sliding:drops.filter(d=>d.state==='sliding').length,archetypes:Object.fromEntries(['lumpy','round','teardrop','streaker','smear'].map(k=>[k,drops.filter(d=>d.archetype===k).length])),caught,missed,elapsedMs:active?performance.now()-startAt:0,score,gauge:Math.round(100*overflow/overflowCapacity),barX:catcherX,barWidth:barWidth*(performance.now()<barWideUntil?1.6:1),trails:streaks.length,visibleTrails:streaks.filter(s=>s.alpha>.15).length,dust:dust.length,stuckOnDust:drops.filter(d=>d.state==='stuck'&&d.dirty).length,kingActive,powerups:powerups.filter(p=>p.until>performance.now()).map(p=>p.id),intensity:Math.max(0,Math.floor(((performance.now()-startAt)/1000-30)/30)),mode,event:eventNow,timeOfDay:scenery.timeOfDay||'day',glassBottom:h*.60,sceneryOffsetM:scenery.distance}),start};
const overflowCapacity=2600,stuckTargets=[60,85,120],slideTargets=[3,6,10];
function dropInside(d){const opts={glassBottom:h*.60,seat:getSeat()};for(let i=0;i<12;i++){const a=i*Math.PI/6;if(!pointInWindow(d.x+Math.cos(a)*d.r,d.y+Math.sin(a)*d.r,w,h,opts))return false}return pointInWindow(d.x,d.y,w,h,opts)}
function randomGlassPoint(){for(let i=0;i<80;i++){const x=w*(.08+Math.random()*.84),y=h*(.06+Math.random()*.51);if(pointInWindow(x,y,w,h,{glassBottom:h*.60,seat:getSeat()}))return {x,y}}return {x:w*.5,y:h*.3}}
function autoSlideCount(){return drops.reduce((n,d)=>n+(d.state==='sliding'),0)}
function resize(){const r=canvas.getBoundingClientRect();dpr=Math.min(devicePixelRatio||1,2);w=r.width;h=r.height;barWidth=w*.18;canvas.width=w*dpr;canvas.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);sharpCanvas=document.createElement('canvas');sharpCanvas.width=Math.max(1,Math.round(w*dpr));sharpCanvas.height=Math.max(1,Math.round(h*.62*dpr));sharpCtx=sharpCanvas.getContext('2d',{willReadFrequently:true});softCanvas=document.createElement('canvas');softCanvas.width=Math.max(1,Math.round(w*dpr/6));softCanvas.height=Math.max(1,Math.round(h*.62*dpr/6));softCtx=softCanvas.getContext('2d');sampleCanvas=document.createElement('canvas');sampleCanvas.width=Math.max(1,Math.ceil(sharpCanvas.width/8));sampleCanvas.height=Math.max(1,Math.ceil(sharpCanvas.height/8));sampleCtx=sampleCanvas.getContext('2d',{willReadFrequently:true});grain=Array.from({length:150},()=>({x:Math.random(),y:Math.random(),r:.35+Math.random()*1.1,a:.03+Math.random()*.04}));if(!catcherX){catcherX=w/2;targetX=w/2}}new ResizeObserver(resize).observe(canvas);resize();
function beep(f=700,d=.1){if(muted)return;try{audio||=new AudioContext();const o=audio.createOscillator(),g=audio.createGain();o.frequency.value=f;g.gain.setValueAtTime(.045,audio.currentTime);g.gain.exponentialRampToValueAtTime(.001,audio.currentTime+d);o.connect(g).connect(audio.destination);o.start();o.stop(audio.currentTime+d)}catch{}}
function toast(t){$('toast').textContent=t;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),950)}
function phase(t){return t<30?0:t<90?1:2}
function hud(t){$('score').textContent=score.toLocaleString('ko-KR');$('combo').textContent=combo;$('coolant').textContent=inventory();$('phase').textContent=['이슬비','굵은 비','폭우'][phase(t)];doorHud.update({score,combo,status:eventNow?(EVENT_NAMES[eventNow]||eventNow):$('phase').textContent,mode:mode==='real'?'진짜 비':'연습',speed:smoothSpeed,limit:feed?.current?.speedLimitKmh,water:100*overflow/overflowCapacity,items:[{count:inventory()},{count:0},{count:0}]})}
function start(){$('finish-run').classList.add('hidden');dust=[];powerups=[];kingActive=false;if(inJourney)speed=smoothSpeed=feed.current.speedKmh;wiper=feed?.current?.wiper??wiper;active=true;ended=false;drops=[];streaks=[];score=combo=maxCombo=caught=missed=biggest=coolant=highCatches=overflow=0;spawn=0;eventNow=null;eventUntil=0;nextEvent=19+Math.random()*6;scorePops=[];startAt=performance.now();mode=wiper?.on?'real':inJourney?'journey':'practice';$('mode').textContent=mode==='real'?'와이퍼 연동':mode==='journey'?'차량 속도 연동':'연습 모드';$('start').classList.add('hidden');$('result').classList.add('hidden');last=startAt;for(let i=0,n=65+Math.floor(Math.random()*16);i<n;i++){const d=createDrop(12+Math.random()*(w-24),36+Math.random()*Math.max(20,h*.48),2.1+Math.random()*3.4);if(d&&i<4){d.level=2;d.r=5+Math.random()*2}}if(params.get('dust')==='1')for(let i=0;i<12;i++)dust.push({x:Math.random()*w,y:20+Math.random()*h*.52,r:12+Math.random()*16});if(params.get('king')==='1'){const d=createDrop(w*.5,h*.35,15,{x:0,y:0},3)||{};d.king=true;d.trailId='warm-king';const points=[];for(let i=0;i<=28;i++)points.push({x:w*.5+Math.sin(i*.12)*7,y:h*.35+i*2.2});streaks.push({id:d.trailId,points,age:0,lifetime:15,width:10,king:true,alpha:.65});d.gone=true;drops=drops.filter(x=>!x.gone)}requestAnimationFrame(frame)}
function finish(reason = 'overflow') {
  if (ended) return;
  ended = true;
  active = false;
  $('finish-run').classList.add('hidden');
  const durationMs = performance.now() - startAt;
  const prior = getBest('raindrop', record => record.stats?.mode === mode);
  const record = saveRecord({ gameId: 'raindrop', score, durationMs, distanceM: 0,
    stats: { mode, caught, biggest, maxCombo, coolant }, endReason: reason });
  const best = !prior || record.score > prior.score;
  if (!inRouteSign && mode === 'real' && best) {
    addItem('gear-paint-a', 1, { from: 'raindrop', record: true });
    try {
      const skins = JSON.parse(localStorage.getItem('zride.skins') || '[]');
      if (!skins.includes('cup_rainbow')) skins.push('cup_rainbow');
      localStorage.setItem('zride.skins', JSON.stringify(skins));
    } catch {}
  }
  $('rain-result-title').textContent = reason === 'completed' ? '도전 완료!' : '창틀이 넘쳤어요';
  $('final-score').textContent = score.toLocaleString('ko-KR');
  $('result-details').textContent = `잡은 방울 ${caught}개 · 최고 연속 ${maxCombo} · 냉각수 ${coolant}`;
  $('best-badge').classList.toggle('hidden', !best);
  $('result').classList.remove('hidden');
  const again = $('again');
  again.disabled = true;
  again.textContent = '다시 도전';
  void presentMinigameReward($('run-reward'), 'raindrop', { score, caught, mode }).then(reward => {
    const returnToMap = inRouteSign && reward.error !== 'SIGN_GOAL_NOT_MET';
    again.dataset.return = String(returnToMap);
    again.textContent = returnToMap ? '여행 지도로 돌아가기' : '다시 도전';
    again.disabled = false;
  });
  beep(180, .35);
}
function createDrop(x=Math.random()*w,y=-8,r=3+Math.random()*3,velocity=null,level=1){if(drops.length>=400)return null;const opts={glassBottom:h*.60,seat:getSeat()};if(!pointInWindow(x,y,w,h,opts))return null;const seed=Math.random()*1000,q=Math.random(),archetype=q<.30?'round':q<.55?'lumpy':q<.80?'teardrop':q<.92?'streaker':'smear',d={x,y,r,state:'stuck',vx:0,vy:0,age:0,rotation:(Math.random()-.5)*Math.PI,aspect:archetype==='round'?.98:.75+Math.random()*.6,archetype,seed,level,inflate:0,inflating:false,phase:Math.random()*6,lobeCount:4+Math.floor(Math.random()*4),lobes:Array.from({length:7},()=>.70+Math.random()*.60),mergedUntil:0,king:false,trailId:Math.random().toString(36).slice(2)};if(velocity){d.state='sliding';d.vx=velocity.x;d.vy=velocity.y;d.level=Math.max(3,level)}drops.push(d);return d}
function beginSlide(a){a.state='sliding';a.vx*=.2;a.vy=Math.max(a.vy,28+a.r*5)}
function merge(p=phase((performance.now()-startAt)/1000)){for(let i=0;i<drops.length;i++){const a=drops[i];if(a.state!=='stuck')continue;for(let j=i+1;j<drops.length;j++){const b=drops[j];if(b.state!=='stuck')continue;const dx=a.x-b.x,dy=a.y-b.y,reach=a.r+b.r+9;if(dx*dx+dy*dy<reach*reach){const aa=a.r*a.r,bb=b.r*b.r;a.x=(a.x*aa+b.x*bb)/(aa+bb);a.y=(a.y*aa+b.y*bb)/(aa+bb);a.r=Math.sqrt(aa+bb);a.aspect=1;a.mergedUntil=performance.now()+850;drops.splice(j,1);j--;if(a.r>=8&&autoSlideCount()<slideTargets[p])beginSlide(a)}}if(a.state==='stuck'&&a.level>=3&&autoSlideCount()<slideTargets[p])beginSlide(a)}}
function scoreDrop(d){const points=Math.max(1,Math.min(40,Math.round(d.r*1.7)));scorePops.push({x:catcherX,y:h*.60-24,text:`+${points*(d.king?2:1)}`,life:1});if(combo>0){comboPop=`${combo+1} COMBO`;comboUntil=performance.now()+1200}combo++;maxCombo=Math.max(combo,maxCombo);score+=points*(d.king?2:1)*(1+Math.min(4,Math.floor(combo/5))*.5);caught++;if(inRouteSign&&caught===1)$('finish-run').classList.remove('hidden');biggest=Math.max(biggest,points);beep(d.level>=3?320:920,.13);if(points>=15){highCatches++;if(!inRouteSign&&highCatches%5===0){addItem('coolant',1,{from:'raindrop'});coolant++;toast('+1 냉각수')}}}
const EVENT_NAMES={gust:'\uB3CC\uD48D',tunnel:'\uD130\uB110',spray:'\uBB3C\uBCF4\uB77C',king:'대왕 방울',lightning:'\uBC88\uAC1C'};function startEvent(name,t){eventNow=name;if(name==='gust')eventSide=travelDir(getSeat());scenery.setTunnel(name==='tunnel');eventUntil=t+4+Math.random()*4;if(name==='lightning')flashUntil=performance.now()+200;if(name==='spray'){const side=frontEdgeX(w,getSeat());for(let i=0;i<25;i++){const d=createDrop(side+(Math.random()-.5)*30,20+Math.random()*h*.5,3+Math.random()*3,null,Math.random()<.2?3:1);if(d&&d.level===3){d.r=8;beginSlide(d)}}}if(name==='king'){const d=createDrop(w*.2+Math.random()*w*.6,-5,15,{x:travelDir(getSeat())*8,y:40},3);if(d){d.king=true;d.r=15}}}function updateEvents(t){if(eventNow&&t>=eventUntil){const endedEvent=eventNow;eventNow=null;scenery.setTunnel(false);nextEvent=t+(phase(t)===2?10+Math.random()*5:15+Math.random()*10);if(endedEvent==='tunnel')for(let i=0;i<12;i++)createDrop(12+Math.random()*(w-24),20+Math.random()*h*.5,3)}if(!eventNow&&t>=nextEvent)startEvent(['gust','tunnel','spray','king','lightning'][Math.floor(Math.random()*5)],t)}function frame(now){if(!active)return;const dt=Math.min((now-last)/1000,.05);last=now;const t=(now-startAt)/1000;previousSmoothSpeed=smoothSpeed;smoothSpeed+=(speed-smoothSpeed)*(1-Math.exp(-dt*2.6));vehicleAccel=Math.max(-6,Math.min(6,(smoothSpeed-previousSmoothSpeed)/3.6/Math.max(dt,.001)));catcherX=targetX;barWidth=w*.18;const p=phase(t),base=[4,6.5,9.5][p],wiperMult=mode==='real'?1+.3*(wiper?.level||0):1,stuckCount=drops.reduce((n,d)=>n+(d.state==='stuck'),0),deficit=Math.max(0,stuckTargets[p]-stuckCount),rate=Math.min(55,base+deficit*.8)*wiperMult*spawnScale;spawn+=dt*(eventNow==='tunnel'?0:rate);while(spawn>=1){spawn-=1;const spawnPoint=randomGlassPoint();let x=spawnPoint.x,y=spawnPoint.y;const nearby=drops.filter(d=>d.state==='stuck');if(nearby.length&&Math.random()<.08){const anchor=nearby[Math.floor(Math.random()*nearby.length)],a=Math.random()*Math.PI*2,dist=Math.random()*12;x=Math.max(8,Math.min(w-8,anchor.x+Math.cos(a)*dist));y=Math.max(35,Math.min(h*.60-8,anchor.y+Math.sin(a)*dist))}createDrop(x,y,2.2+Math.random()*3)}
  updateEvents(t);
  merge(p);let growingCount=drops.reduce((n,d)=>n+(d.state==="stuck"&&d.inflating?1:0),0);for(const d of drops){d.age+=dt;if(d.state==='stuck'&&eventNow!=='tunnel'){if(d.age>4&&d.level<3&&!d.inflating&&growingCount<Math.max(16,Math.floor(stuckTargets[p]*.22))){d.inflating=true;growingCount++;d.inflate=0;d.inflateDuration=.35+Math.random()*.35}if(d.inflating){d.inflate+=dt*(eventNow==='lightning'?2:1);d.r+=dt*3;d.phase+=dt*22;if(d.inflate>=d.inflateDuration){d.inflating=false;d.level++;d.r=d.level===2?4.8:6.8;if(d.level>=2&&autoSlideCount()<slideTargets[p])beginSlide(d)}}}if(d.state==='sliding'){const back=Math.max(-1.2,Math.min(1.2,smoothSpeed/120+(windKmh+(eventNow==='gust'?45*eventSide:0))/30)),dir=-travelDir(getSeat()),len=Math.hypot(back,1),tau=.2+d.r*.12,targetX=dir*back/len*(58+d.r*9)-vehicleAccel*travelDir(getSeat())*(.4+1/Math.max(1,d.r));d.vx+=(targetX-d.vx)*(1-Math.exp(-dt/tau));d.vy+=(1/len*(58+d.r*9)-d.vy)*(1-Math.exp(-dt/tau));d.x+=d.vx*dt;d.y+=d.vy*dt;let trail=streaks.find(s=>s.id===d.trailId);if(!trail){trail={id:d.trailId,points:[],age:0,lifetime:d.king?15:8,width:d.king?10:4,king:d.king,alpha:.6};streaks.push(trail)}trail.age=0;trail.points.push({x:d.x,y:d.y});if(trail.points.length>180)trail.points.shift();for(const other of drops){if(other===d||other.gone||other.state!=='stuck')continue;if(Math.hypot(d.x-other.x,d.y-other.y)<d.r+other.r+6){d.r=Math.sqrt(d.r*d.r+other.r*other.r);d.level=Math.min(3,d.level+1);d.vx*=1.25;d.vy*=1.25;other.gone=true}}if(d.x<-8||d.x>w+8){overflow+=Math.min(28,8+d.r*1.4);missed++;d.gone=true;combo=0}if(d.y>=h*.60-8&&d.y<h*.60-2&&d.x>catcherX-catcherHalfWidth()&&d.x<catcherX+catcherHalfWidth()){scoreDrop(d);d.gone=true}else if(d.y>=h-30){overflow+=Math.min(28,8+d.r*1.4);missed++;d.gone=true;combo=0;beep(230,.08)}}}
  for(const d of drops)if(!d.gone&&!dropInside(d)){if(d.y>=h*.60-12){overflow+=Math.min(28,8+d.r*1.4);missed++;combo=0}d.gone=true}for(const s of streaks){s.age+=dt;s.points=s.points.filter(p=>pointInWindow(p.x,p.y,w,h,{glassBottom:h*.60,seat:getSeat()}))}for(const c of dust)if(drops.some(d=>d.state==='sliding'&&Math.hypot(d.x-c.x,d.y-c.y)<d.r+c.r)){c.cleaned=true;for(const d of drops)if(d.state==='sliding'&&Math.hypot(d.x-c.x,d.y-c.y)<d.r+c.r)d.dirty=true}dust=dust.filter(c=>!c.cleaned&&pointInWindow(c.x,c.y,w,h,{glassBottom:h*.60,seat:getSeat()}));drops=drops.filter(d=>!d.gone&&dropInside(d));scorePops=scorePops.filter(a=>(a.life-=dt)>0);streaks=streaks.filter(s=>s.age<s.lifetime&&s.points.length>1);if(overflow>overflowCapacity){finish();return}scenery.update(dt,smoothSpeed,getSeat());hud(t);draw(now,t);requestAnimationFrame(frame)}
function dropPath(d){const sliding=d.state==='sliding',angle=sliding?Math.atan2(d.vx,d.vy):(d.rotation||0)-vehicleAccel*travelDir(getSeat())*.035,stretch=sliding?(d.archetype==='streaker'?1.9:1.3):1.03,rx=d.r*(sliding?.86:d.archetype==='smear'?1.45:1.02),ry=d.r*(sliding?stretch:(d.aspect||1));return {angle,rx,ry,sliding}}
function traceDrop(d,shape){const {rx,ry,sliding}=shape;ctx.beginPath();if(sliding||d.archetype==='teardrop'){/* round bulb leads (bottom), short soft tail trails (top) */const hr=rx,cy=Math.max(0,ry-hr),tip=-ry,tr=Math.max(1.2,hr*.34),mid=cy-(cy-tip)*.5;ctx.moveTo(-hr,cy);ctx.arc(0,cy,hr,Math.PI,0,true);ctx.bezierCurveTo(hr,mid,tr,tip+tr*1.6,tr*.6,tip+tr*.5);ctx.quadraticCurveTo(0,tip-tr*.2,-tr*.6,tip+tr*.5);ctx.bezierCurveTo(-tr,tip+tr*1.6,-hr,mid,-hr,cy)}else if(d.archetype==='round'){ctx.ellipse(0,0,rx,ry,0,0,Math.PI*2)}else{const n=d.mergedUntil>performance.now()?6:(d.lobeCount||4),lobes=d.lobes||[1,1,1,1,1];for(let i=0;i<=n*8;i++){const a=i/(n*8)*Math.PI*2,idx=Math.floor(i/8)%lobes.length,relax=d.mergedUntil>performance.now()?1:0,amp=(lobes[idx]-1)*(1-relax*.7),r=1+amp*Math.sin(a*n/2+d.seed+Math.sin(performance.now()/650+d.phase));const x=Math.cos(a)*rx*r,y=Math.sin(a)*ry*r;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}}ctx.closePath()}
let lensDrawn=0;
function drawDrop(d){ctx.save();const shape=dropPath(d);ctx.translate(d.x,d.y);ctx.rotate(shape.angle);traceDrop(d,shape);ctx.clip();const r=Math.max(shape.rx,shape.ry);if(r>=5&&lensDrawn<70){lensDrawn++;ctx.rotate(Math.PI);const side=r*3.5*2;ctx.drawImage(sharpCanvas,Math.max(0,d.x*dpr-side/2),Math.max(0,d.y*dpr-side/2),side,side,-r*3.5,-r*3.5,r*7,r*7)}else{const px=Math.max(0,Math.min(sampleCanvas.width-1,Math.round((w-d.x)*dpr/8))),py=Math.max(0,Math.min(sampleCanvas.height-1,Math.round((h*.62-d.y)*dpr/8))),i=(py*sampleCanvas.width+px)*4;const p=samplePixels;ctx.fillStyle=p?`rgb(${p[i]},${p[i+1]},${p[i+2]})`:'#9ca9b3';ctx.fillRect(-r*2,-r*2,r*4,r*4)}const rim=ctx.createRadialGradient(0,-r*.2,r*.25,0,0,r*1.25);rim.addColorStop(0,'rgba(9,17,29,0)');rim.addColorStop(.72,'rgba(12,20,31,.10)');rim.addColorStop(1,'rgba(7,15,28,.58)');ctx.fillStyle=rim;ctx.fillRect(-r*2,-r*2,r*4,r*4);ctx.fillStyle=d.dirty?'rgba(91,75,57,.20)':'rgba(255,255,255,.09)';ctx.fillRect(-r*2,-r*2,r*4,r*4);ctx.restore();ctx.save();ctx.translate(d.x,d.y);ctx.rotate(shape.angle);ctx.fillStyle='rgba(255,255,255,.9)';ctx.beginPath();ctx.ellipse(-shape.rx*.28,-shape.ry*.53,Math.max(1,d.r*.12),Math.max(1,d.r*.09),-.35,0,Math.PI*2);ctx.fill();ctx.strokeStyle='rgba(255,255,255,.76)';ctx.lineWidth=Math.max(.7,d.r*.08);ctx.beginPath();ctx.arc(0,shape.ry*.2,shape.rx*.68,.16*Math.PI,.82*Math.PI);ctx.stroke();const bright=(scenery.timeOfDay==='night')?'rgba(230,240,255,.54)':'rgba(4,17,31,.4)';ctx.strokeStyle=bright;ctx.lineWidth=.65;traceDrop(d,shape);ctx.stroke();ctx.restore()}
function draw(now,t){const viewBottom=h*.60,opts={glassBottom:viewBottom,seat:getSeat()};drawSideWindow(viewBottom);ctx.save();traceWindow(ctx,w,h,opts);ctx.clip('evenodd');for(const s of streaks){if(s.points.length<2)continue;ctx.globalAlpha=Math.max(s.age<3?.38:.18,.55*(1-s.age/s.lifetime));ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='rgba(242,248,255,.24)';ctx.lineWidth=s.width;ctx.beginPath();ctx.moveTo(s.points[0].x,s.points[0].y);for(let i=1;i<s.points.length;i++)ctx.lineTo(s.points[i].x,s.points[i].y);ctx.stroke();ctx.strokeStyle='rgba(255,255,255,.52)';ctx.lineWidth=Math.max(1,s.width*.09);ctx.stroke();for(let i=2;i<s.points.length;i+=4){ctx.fillStyle='rgba(255,255,255,.6)';ctx.beginPath();ctx.arc(s.points[i].x,s.points[i].y,s.width*.14,0,Math.PI*2);ctx.fill()}}ctx.globalAlpha=1;for(const g of grain){ctx.fillStyle=`rgba(226,218,200,${g.a})`;ctx.beginPath();ctx.arc(g.x*w,g.y*viewBottom,g.r,0,Math.PI*2);ctx.fill()}for(const c of dust){const rg=ctx.createRadialGradient(c.x,c.y,0,c.x,c.y,c.r);rg.addColorStop(0,'rgba(112,91,69,.26)');rg.addColorStop(.65,'rgba(112,91,69,.16)');rg.addColorStop(1,'rgba(112,91,69,0)');ctx.fillStyle=rg;ctx.beginPath();ctx.arc(c.x,c.y,c.r,0,Math.PI*2);ctx.fill()}lensDrawn=0;for(const d of drops)if(d.y<viewBottom)drawDrop(d);const barY=viewBottom-8;const bw=catcherHalfWidth()*2;ctx.save();ctx.translate(catcherX,barY);ctx.fillStyle='#d9e0e5';ctx.strokeStyle='#44515a';ctx.lineWidth=2;ctx.beginPath();ctx.roundRect(-bw/2,-4,bw,8,4);ctx.fill();ctx.stroke();ctx.restore();if(now<flashUntil){ctx.fillStyle='rgba(255,255,255,.35)';ctx.fillRect(0,0,w,viewBottom)}ctx.restore();drawLowerHud()}
function drawSideWindow(bottom) {
  sharpCtx.setTransform(1,0,0,1,0,0);sharpCtx.clearRect(0,0,sharpCanvas.width,sharpCanvas.height);sharpCtx.scale(dpr,dpr);scenery.draw(sharpCtx,0,0,w,bottom,{rain:true});sampleCtx.clearRect(0,0,sampleCanvas.width,sampleCanvas.height);sampleCtx.drawImage(sharpCanvas,0,0,sampleCanvas.width,sampleCanvas.height);samplePixels=sampleCtx.getImageData(0,0,sampleCanvas.width,sampleCanvas.height).data;
  softCtx.setTransform(1,0,0,1,0,0);softCtx.clearRect(0,0,softCanvas.width,softCanvas.height);softCtx.scale(dpr/6,dpr/6);softCtx.filter='blur(1.2px)';softCtx.drawImage(sharpCanvas,0,0,w,bottom);softCtx.filter='none';
  ctx.clearRect(0,0,w,h);ctx.save();traceWindow(ctx,w,h,{glassBottom:bottom,seat:getSeat()});ctx.clip('evenodd');ctx.imageSmoothingEnabled=true;ctx.drawImage(softCanvas,0,0,softCanvas.width,softCanvas.height,0,0,w,bottom);for(let i=0;i<9;i++){const bx=(i*97%w),by=bottom*(.2+(i*37%55)/100),r=2+(i%4)*1.8,glow=ctx.createRadialGradient(bx,by,0,bx,by,r*4);glow.addColorStop(0,'rgba(218,232,226,.18)');glow.addColorStop(1,'rgba(218,232,226,0)');ctx.fillStyle=glow;ctx.beginPath();ctx.arc(bx,by,r*4,0,Math.PI*2);ctx.fill()}ctx.restore();drawWindowFrame(ctx,w,h,{glassBottom:bottom,seat:getSeat()});
  return;
  const driveOffset = (performance.now() * Math.max(0, smoothSpeed) / 4200) % Math.max(1, w);
  ctx.fillStyle = '#10182d';
  ctx.fillRect(0, 0, w, bottom);
  ctx.fillStyle = '#171a36';
  ctx.beginPath();
  ctx.moveTo(0, bottom * .51);
  ctx.lineTo(w * .4, bottom * .35);
  ctx.lineTo(w, bottom * .53);
  ctx.lineTo(w, bottom);
  ctx.lineTo(0, bottom);
  ctx.fill();
  ctx.strokeStyle = '#7775c7';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, bottom * .72);
  ctx.quadraticCurveTo(w * .52, bottom * .51, w, bottom * .58);
  ctx.stroke();

  // Passing lamps and low skyline move with vehicle speed behind the glass.
  ctx.save(); ctx.globalAlpha = .65; ctx.shadowColor = '#c0baff'; ctx.shadowBlur = 12;
  for (let i = 0; i < 7; i++) {
    const x = ((i * 137 - driveOffset) % (w + 80) + w + 80) % (w + 80) - 40;
    ctx.fillStyle = i % 2 ? '#ff796c' : '#c0baff';
    ctx.fillRect(x, bottom * (.43 + (i % 3) * .045), 3, bottom * .22);
    ctx.fillRect(x - 15, bottom * .67, 34, bottom * .025);
  }
  ctx.restore();
  const legacyReflection = ctx.createLinearGradient(0, 0, w * .55, bottom);
  legacyReflection.addColorStop(0, 'rgba(255,255,255,.02)'); legacyReflection.addColorStop(.48, 'rgba(192,186,255,.14)'); legacyReflection.addColorStop(.58, 'rgba(255,255,255,.02)');
  ctx.fillStyle = legacyReflection; ctx.fillRect(0, 28, w, bottom - 28);

  // The roof, pillar and door sill stay fixed as the scenery drifts behind the glass.
  ctx.fillStyle = '#101f2b';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(w, 0);
  ctx.lineTo(w, 28);
  ctx.quadraticCurveTo(w * .48, -3, 0, 36);
  ctx.fill();
  const right = travelDir(getSeat()) < 0;
  ctx.save();
  if (right) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(12, 0);
  ctx.lineTo(26, bottom);
  ctx.lineTo(0, bottom);
  ctx.fill();
  ctx.restore();
  ctx.fillRect(0, bottom - 2, w, 9);
  ctx.fillStyle = '#182330';
  ctx.fillRect(0, bottom + 7, w, h - bottom - 7);
  ctx.strokeStyle = '#c0baff';
  ctx.shadowColor = '#c0baff'; ctx.shadowBlur = 5; ctx.lineWidth = 3;
  const handleX = right ? w * .69 : w * .14;
  ctx.beginPath();
  ctx.roundRect(handleX, bottom + 24, w * .17, 9, 4);
  ctx.stroke();
  ctx.restore();
}

function drawLowerHud(){}
function pointer(e){const r=canvas.getBoundingClientRect();targetX=Math.max(barWidth/2,Math.min(w-barWidth/2,e.clientX-r.left));catcherX=targetX}canvas.addEventListener('pointerdown',e=>{pointer(e);canvas.setPointerCapture(e.pointerId);let best=null,dist=30;for(const d of drops)if(d.state==='stuck'){const n=Math.hypot(d.x-(e.clientX-canvas.getBoundingClientRect().left),d.y-(e.clientY-canvas.getBoundingClientRect().top));if(n<dist){dist=n;best=d}}if(best){best.state='sliding';const dir=-travelDir(getSeat()),back=Math.min(smoothSpeed/120,1.2),len=Math.hypot(back,1);best.vx=dir*back/len*30;best.vy=1/len*30;beep(560,.05)}});canvas.addEventListener('pointermove',e=>{if(e.buttons)pointer(e)});
function dropNear() {
  if (!active) return;
  const reach = catcherHalfWidth() + 10;
  let target;
  for (const drop of drops) {
    if (drop.state !== 'stuck' || Math.abs(drop.x - targetX) > reach) continue;
    if (!target || drop.y > target.y) target = drop;
  }
  if (!target) { toast('물받이를 빗방울 아래에 놓아 보세요.'); return; }
  beginSlide(target);
  beep(560, .05);
}
window.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){targetX=Math.max(30,Math.min(w-30,targetX+(e.key==='ArrowRight'?36:-36)));e.preventDefault()}if(e.code==='Space'){dropNear();e.preventDefault()}});
if(dev){feed=createVehicleFeed({dev});feed.on('update',v=>{speed=v.speedKmh;windKmh=Number(v.windKmh)||0;wiper=v.wiper||null});feed.addDevControl({label:'Rain intensity',min:.5,max:3,step:.1,value:1,onInput:v=>spawnScale=v})}
if(dev){const panel=document.createElement('div');panel.className='rain-dev-tools';const gear=document.createElement('button');gear.type='button';gear.className='icon-button rain-gear';gear.textContent='설정';gear.setAttribute('aria-label','개발 패널');const tools=document.createElement('div');tools.className='rain-dev-panel hidden';const actions=[['대왕 방울',()=>startEvent('king',(performance.now()-startAt)/1000)],['터널',()=>startEvent('tunnel',(performance.now()-startAt)/1000)],['먼지',()=>{for(let i=0;i<12;i++)dust.push({x:Math.random()*w,y:20+Math.random()*h*.55,r:10+Math.random()*10})}],['바 확장',()=>barWideUntil=performance.now()+10000],['낮',()=>scenery.setTimeOfDay('day')],['노을',()=>scenery.setTimeOfDay('dusk')],['밤',()=>scenery.setTimeOfDay('night')]];for(const [label,action] of actions){const button=document.createElement('button');button.type='button';button.className='primary-button';button.textContent=label;button.addEventListener('click',action);tools.append(button)}gear.addEventListener('click',()=>tools.classList.toggle('hidden'));panel.append(gear,tools);document.body.append(panel)}document.querySelector('#start-button').addEventListener('click',async()=>{if(!await ensurePassenger())return;if(!feed){feed=createVehicleFeed({dev});feed.on('update',v=>{speed=v.speedKmh;windKmh=Number(v.windKmh)||0;wiper=v.wiper||null})}if(!wiper&&!dev&&!inJourney)$('notice').textContent='와이퍼 신호 없음 · 연습 모드';audio?.resume();start()});$('again').addEventListener('click', () => { if ($('again').dataset.return === 'true') returnToJourney(); else start(); });$('drop').addEventListener('click',dropNear);$('mute').addEventListener('click',e=>{muted=!muted;e.currentTarget.textContent=muted?'◖':'◗'});
const rainGear=document.querySelector('.rain-dev-tools');
if(dev){const tools=document.querySelector('.rain-dev-panel');for(const [label,delta] of [['급가속',12.96],['급제동',-12.96]]){const button=document.createElement('button');button.type='button';button.className='primary-button';button.textContent=label;button.addEventListener('click',()=>devSpeedRamp(delta));tools?.append(button)}}
document.getElementById("start-button").disabled = false;
if (dev && params.get('autostart') === '1') { start(); const warm=Math.min(30,Math.max(0,Number(params.get('warm'))||0));if(warm){for(const d of drops)d.age=warm;for(let i=0;i<Math.min(40,Math.floor(warm*1.4));i++){const d=createDrop(8+Math.random()*(w-16),24+Math.random()*h*.52,1.5+Math.random()*4);if(d)d.age=warm}} }

$('finish-run').addEventListener('click',()=>finish('completed'));

notifyJourneyReady();
