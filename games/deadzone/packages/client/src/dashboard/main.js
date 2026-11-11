// Z-RIDE dashboard adapter, 2026-11-06. Apache-2.0.
import QRCode from 'qrcode';
import { DEFENSE_WAVES, VEHICLE_HALF_WIDTH, VEHICLE_HALF_LENGTH } from '@overrun/shared/vehicle-defense.js';
const $ = id => document.getElementById(id);
const embeddedVehicle=window.parent!==window||(/Android/.test(navigator.userAgent)&&/wv/.test(navigator.userAgent));
let fitting=false;
let fittedRoster=null;
if(embeddedVehicle)document.body.style.zoom='1';
function fitVehicle(){
 if(!embeddedVehicle||fitting)return;
 fitting=true;let step=0;
 const fit=()=>{
  const height=document.querySelector('.cockpit').getBoundingClientRect().height;
  const zoom=Number(document.body.style.zoom)||1;
  const next=Math.min(1,zoom*(innerHeight-8)/Math.max(1,height));
  if(Math.abs(next-zoom)>.005)document.body.style.zoom=String(Math.max(.65,next));
  if(++step<3)requestAnimationFrame(fit);else fitting=false;
 };requestAnimationFrame(fit);
}
addEventListener('resize',fitVehicle);
const colors=['#d5ef77','#78c8df','#e9ac70','#b1a1e2'];
let roomCode='', token='', lastUpdate=0, lastState=null, inFlight=false;
const practice=new URLSearchParams(location.search).has('practice');
const emptySlot = n => {const el=document.createElement('article');el.className='player-card empty';el.innerHTML=`<span class="slot-num">0${n+1}</span><div><b>팀원을 기다려요</b><p>폰으로 QR 스캔 후 참가</p></div><span class="empty-icon">＋</span>`;return el;};
function paintPlayers(players, capacity) {
  $('players').replaceChildren();
  const ranked=[...players].sort((a,b)=>b.score-a.score);
  for(let i=0;i<capacity;i++){
    const p=ranked[i]; if(!p){$('players').append(emptySlot(i));continue;}
    const el=document.createElement('article');el.className='player-card';
    const avatar=document.createElement('div');avatar.className='avatar';avatar.style.color=colors[i%4];avatar.textContent=String(i+1).padStart(2,'0');
    const details=document.createElement('div');details.className='player-details';
    const name=document.createElement('b');name.textContent=p.name;
    const label=document.createElement('p');label.textContent=!p.connected?'재접속 대기':p.hp===null?(p.ready?'준비 완료':'준비 중'):p.down?'구조 필요':p.alive?'생존 중':'전투 불능';
    const bar=document.createElement('div');bar.className='health-track';const fill=document.createElement('i');fill.style.width=(p.hp===null?0:Math.max(0,Math.min(100,p.hp/(p.maxHp||100)*100)))+'%';fill.style.background=p.down?'#f19365':colors[i%4];bar.append(fill);
    details.append(name,label,bar);
    const points=document.createElement('div');points.className='player-points';const score=document.createElement('b');score.textContent=p.score.toLocaleString();const kills=document.createElement('small');kills.textContent=p.kills+' KILLS';points.append(score,kills);
    el.append(avatar,details,points);$('players').append(el);
  }
}
function radar(data) {
 const canvas=$('radar'),g=canvas.getContext('2d'),W=canvas.width,H=canvas.height;
 g.fillStyle='#152724';g.fillRect(0,0,W,H);
 const r=data?.arenaRadius||46,scale=Math.min(W,H)*.43/r,cx=W*.5,cy=H*.5;
 g.strokeStyle='#74948223';g.lineWidth=1;
 for(let x=0;x<W;x+=35){g.beginPath();g.moveTo(x,0);g.lineTo(x,H);g.stroke();}
 for(let y=0;y<H;y+=35){g.beginPath();g.moveTo(0,y);g.lineTo(W,y);g.stroke();}
 g.strokeStyle='#a8ba8b35';g.lineWidth=2;
 for(let row of [-1,1])for(let col=-4;col<=4;col++){const x=cx+col*69,y=cy+row*175;g.strokeRect(x-27,y-52,54,104);g.fillStyle='#9dae8c44';g.font='13px monospace';g.fillText('P'+(col+5),x-12,y+6);}
 g.setLineDash([10,14]);g.strokeStyle='#c9dc7d55';g.beginPath();g.moveTo(cx-345,cy);g.lineTo(cx+345,cy);g.stroke();g.setLineDash([]);
 g.strokeStyle='#d6ef7760';g.beginPath();g.arc(cx,cy,r*scale,0,Math.PI*2);g.stroke();
 if (data?.defense) {
   const d = data.defense, w = VEHICLE_HALF_WIDTH * scale, l = VEHICLE_HALF_LENGTH * scale;
   if (d.flash > 0) {
     g.fillStyle = '#a4e8fa44'; g.beginPath();
     g.moveTo(cx-w,cy-l); g.lineTo(cx-11.5*scale,cy-l-15*scale);
     g.lineTo(cx+11.5*scale,cy-l-15*scale); g.lineTo(cx+w,cy-l); g.fill();
   }
   g.fillStyle = d.hp / d.maxHp <= 0.35 ? '#ef966c' : '#d5ef77';
   g.fillRect(cx-w,cy-l,w*2,l*2);
   g.fillStyle = '#223c39'; g.fillRect(cx-w*.65,cy-l*.58,w*1.3,l*1.05);
   g.fillStyle = '#e8f3cc'; g.font = 'bold 12px system-ui';
   g.fillText('우리 차',cx+w+5,cy+l+9);
   for (const p of data.pickups) {
     if (p.k !== 'fuse') continue;
     g.fillStyle = '#60ffe1';
     g.fillRect(cx+p.x*scale-3,cy+p.z*scale-3,6,6);
   }
 }
 for(const e of data?.enemies||[]){g.fillStyle='#ed8a6b';g.beginPath();g.arc(cx+e.x*scale,cy+e.z*scale,3.5,0,Math.PI*2);g.fill();}
 for(const [i,p] of (data?.players||[]).entries()){
  const x=cx+p.x*scale,y=cy+p.z*scale;g.fillStyle=colors[i%4]+'20';g.beginPath();g.arc(x,y,19,0,Math.PI*2);g.fill();g.fillStyle=colors[i%4];g.beginPath();g.arc(x,y,7,0,Math.PI*2);g.fill();g.fillStyle='#eef1de';g.font='bold 13px system-ui';g.fillText(p.name.slice(0,12),x+12,y+5);
 }
}
function renderDefense(s) {
 const d = s.defense;
 $('defenseStatus').hidden = !d || s.state === 'lobby' || s.state === 'countdown';
 if ($('defenseStatus').hidden) return;
 $('defenseHp').textContent = d.hp + ' / ' + d.maxHp;
 $('defenseFill').style.width = (100 * d.hp / d.maxHp) + '%';
 $('defenseFill').classList.toggle('critical', d.hp / d.maxHp <= 0.35);
 $('defenseFuses').textContent = d.fuses + '개' + (d.flash > 0 ? ' · 라이트 켜짐' : '');
 const directions = { '앞': 0, '뒤': 0, '왼쪽': 0, '오른쪽': 0 };
 for (const e of s.enemies) {
   if (Math.hypot(e.x, e.z) > 25) continue;
   const direction = Math.abs(e.x) > Math.abs(e.z)
     ? (e.x > 0 ? '오른쪽' : '왼쪽') : (e.z > 0 ? '뒤' : '앞');
   directions[direction]++;
 }
 const [direction, count] = Object.entries(directions).sort((a,b) => b[1] - a[1])[0];
 $('defenseDirection').textContent = count ? direction + ' · ' + count + '마리' : '주변 이상 없음';
}

function render(s) {
 lastState=s;lastUpdate=Date.now();$('alert').hidden=true;
 $('sourceChip').textContent=practice?'AI 동료 체험 중':'실시간 연결';$('sourceChip').classList.add('connected');
 $('roomLabel').textContent=practice?'LOCAL PRACTICE · 실제 체험 상태':`팀 ${s.roomCode} · ${s.targetPlayers}인 협동전`;
 const labels={lobby:'TEAM STANDBY',countdown:'GET READY',playing:'SURVIVE TOGETHER',ended:'MISSION COMPLETE',practice:'PRACTICE MODE',paused:'PRACTICE PAUSED'};
 $('stateLabel').textContent=labels[s.state]||s.state;
 $('mapNote').textContent=s.state==='lobby'?'팀원 모두 폰에서 준비를 완료하면 시작합니다.':s.state==='ended'?'이번 경기 결과입니다. 다음 도전을 준비하세요.':'팀원의 위치와 좀비 접근을 확인하세요.';
 if (s.state === 'ended' && s.outcome) {
   const result = { vehicle_defended: '차량 방어 성공', vehicle_destroyed: '차량 파괴', wipe: '팀 전투 불능' }[s.outcome];
   if (result) $('stateLabel').textContent = result;
 }
 renderDefense(s);
 $('wave').textContent=String(s.wave).padStart(2,'0')+(s.defense && s.wave ? ' / '+DEFENSE_WAVES : '');$('phase').textContent=s.phase==='choice'?'보급품 업그레이드 선택 중':s.state==='playing'?'좀비 웨이브 진행 중':'팀 상태: '+({lobby:'참가 대기',countdown:'시작 카운트다운',ended:'경기 종료',practice:'AI 동료 체험',paused:'체험 일시정지'}[s.state]||s.state);
 $('headcount').replaceChildren(document.createTextNode(String(s.players.filter(p=>p.alive!==false&&p.connected).length)+' '));const total=document.createElement('em');total.textContent='/ '+s.targetPlayers;$('headcount').append(total);
 $('difficulty').textContent=`${s.difficulty.label} · 출현량 ×${s.difficulty.spawnMultiplier.toFixed(2)}`;
 $('score').textContent=s.teamScore.toLocaleString();$('kills').textContent='좀비 처치 '+s.kills;
 $('elapsed').textContent=String(Math.floor(s.elapsed/60)).padStart(2,'0')+':'+String(Math.floor(s.elapsed%60)).padStart(2,'0');
 $('threat').textContent='접근 중인 좀비 '+s.enemies.length+'마리';$('rosterCount').textContent=s.players.length+' PLAYERS';
 $('syncLabel').textContent='방금 갱신 · '+(practice?'브라우저 체험 상태':'서버 경기 상태');paintPlayers(s.players,s.targetPlayers);radar(s);
 if(fittedRoster!==s.targetPlayers){fittedRoster=s.targetPlayers;fitVehicle();}
 // Optional native host integration: the host may expose this one-way bridge.
 if(window.ZRideDashboardBridge?.onSnapshot)window.ZRideDashboardBridge.onSnapshot(JSON.stringify(s));
}
async function attach(code,key) {
 roomCode=code;token=key;location.hash=code+'.'+key;
 if(parent!==window)parent.postMessage({type:'zride:dashboard-room',code,joinPath:'/j/'+code},location.origin);
 $('code').textContent=code;$('createForm').hidden=true;$('newRoom').hidden=false;$('qrPlaceholder').hidden=true;
 $('joinLink').hidden=false;$('joinLink').href='/j/'+code;
 await QRCode.toCanvas($('qr'),location.origin+'/j/'+code,{width:190,margin:2,color:{dark:'#14251d',light:'#f3f4e9'}});
 $('networkNote').textContent=['localhost','127.0.0.1'].includes(location.hostname)?'폰 참가: 같은 Wi-Fi에서 Mac의 LAN 주소로 이 화면을 열어 QR을 사용하세요.':'';
 await poll();
}
async function poll(){
 if(!roomCode||inFlight||practice)return;
 inFlight=true;
 try {const r=await fetch('/api/zride/rooms/'+roomCode+'/status',{headers:{'x-dashboard-token':token},cache:'no-store'});if(!r.ok)throw new Error(r.status===403?'대시보드 연결 키가 유효하지 않습니다. 새 팀을 만들어 주세요.':'방에 연결할 수 없습니다. 서버 또는 경기 상태를 확인해 주세요.');render(await r.json());}
 catch(e){$('sourceChip').textContent='연결 끊김';$('sourceChip').classList.remove('connected');$('alert').hidden=false;$('alert').textContent=e.message;$('syncLabel').textContent=lastUpdate?'마지막 갱신 '+Math.floor((Date.now()-lastUpdate)/1000)+'초 전':'수신 데이터 없음';}
 finally{inFlight=false;}
}
$('createRoom').onclick=async()=>{
 const b=$('createRoom');b.disabled=true;
 try{const r=await fetch('/api/zride/rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({players:Number($('partySize').value),hostName:'차량 대시보드'})});if(!r.ok)throw new Error('팀을 만들지 못했습니다. 다시 시도해 주세요.');const s=await r.json();await attach(s.code,s.dashboardToken);}
 catch(e){$('alert').textContent=e.message;$('alert').hidden=false;}finally{b.disabled=false;}
};
$('newRoom').onclick=()=>{location.href='/dashboard';};
paintPlayers([],4);radar(null);fitVehicle();
if(practice){
 $('createForm').hidden=true;$('code').textContent='AI PRACTICE';$('joinHint').textContent='혼자 체험 화면과 연결됩니다. 실제 폰 참가는 협동 방을 이용하세요.';
 $('qrPlaceholder').innerHTML='Z<span>AI 동료 체험<br>참가 QR 없음</span>';
 $('mapNote').textContent='게임 화면에서 혼자 체험하기를 시작하세요.';
 const channel=new BroadcastChannel('zride.practice.v1');channel.onmessage=e=>{if(e.data?.schema==='zride.dashboard.v1')render(e.data);};
}else{const [code,key]=location.hash.slice(1).split('.');if(/^[A-Z2-9]{6}$/.test(code||'')&&key)attach(code,key);}
setInterval(()=>{$('clock').textContent=new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',hour12:false});if(lastUpdate&&Date.now()-lastUpdate>5000){$('sourceChip').textContent='갱신 지연';$('sourceChip').classList.remove('connected');$('syncLabel').textContent='마지막 갱신 '+Math.floor((Date.now()-lastUpdate)/1000)+'초 전';}},1000);
setInterval(poll,1000);
