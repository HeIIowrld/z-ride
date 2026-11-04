import RFB from '/vehicles/novnc/core/rfb.js';
const id=location.pathname.match(/\/vehicles\/([123])\/?$/)?.[1],status=document.getElementById('status');
let rfb,connecting=false;
if(!id)status.textContent='차량 주소를 확인해 주세요.';
async function connect(){if(!id||rfb||connecting)return;connecting=true;try{const response=await fetch('/vehicles/status.json',{cache:'no-store'});if(!response.ok)throw new Error();const value=await response.json(),vehicle=value.vehicles.find(v=>v.id===id);document.getElementById('title').textContent='Pleos 차량 '+id;
 if(!vehicle||vehicle.state==='STOPPED'){status.textContent='현재 중지된 차량임. 실행 전에는 화면을 송출하지 않음.';return;}
 status.textContent='실제 에뮬레이터 화면에 연결 중…';
 rfb=new RFB(document.getElementById('screen'),`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/vehicles/ws/${id}`);
 rfb.viewOnly=false;rfb.scaleViewport=true;rfb.resizeSession=false;rfb.showDotCursor=true;rfb.focusOnClick=true;
 rfb.addEventListener('connect',()=>{status.textContent='Pleos 차량 '+id+' · 실제 화면 연결됨 · 웹 조작 가능';});
 rfb.addEventListener('disconnect',()=>{rfb=null;status.textContent='화면 연결이 끊김. 실행 상태를 확인하고 다시 연결함.';});
}catch{status.textContent='차량 화면 연결을 확인하는 중…';}finally{connecting=false;}}
void connect();setInterval(connect,5000);window.addEventListener('pagehide',()=>rfb?.disconnect());
