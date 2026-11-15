const id=location.pathname.match(/\/vehicles\/([123])\/?$/)?.[1],panel=document.getElementById('native-navigation'),label=document.getElementById('native-navigation-state');let busy=false;
const completionLabels={
  MOTION_CONFIRMED:'차량 앱에서 기어와 속도를 확인했습니다.',
  MOTION_NOT_CONFIRMED:'차량 앱에서 요청한 기어·속도를 확인하지 못했습니다.',
  NATIVE_POSITION_CONFIRMED:'순정 내비에서 새 위치를 확인했습니다.',
  NATIVE_POSITION_NOT_CONFIRMED:'좌표를 보냈지만 순정 내비는 새 위치를 보고하지 않았습니다.',
};
const commandErrors = {
  NAVIGATION_SDK_NOT_CONNECTED: 'Pleos에서 PLY 앱을 열어 내비 연결을 확인해 주세요.',
  DEMO_JOURNEY_ACTIVE: '현재 여정을 주차하거나 일시정지한 뒤 내비를 조작해 주세요.'
};
async function refresh(){try{const r=await fetch(`/vehicles/navigation/${id}`,{cache:'no-store'});if(!r.ok)throw Error();const s=await r.json();label.textContent=`NaviHelper ${s.sdkConnected?'연결됨':'연결 확인 중'} · ${s.status||s.event||'대기'} · SDK 경로 #${s.routeRevision??0}${s.error?' · '+s.error:''} · 도로 폴리라인 미제공`;}catch{label.textContent='SDK 상태 확인 중…';}}
panel.addEventListener('click',async e=>{const b=e.target.closest('button[data-navi]');if(!b||busy)return;busy=true;try{const r=await fetch(`/vehicles/navigation/${id}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:b.dataset.navi})});const v=await r.json();document.getElementById('native-navigation-result').textContent=r.ok?(completionLabels[v.completion]||'요청 전달됨 · 아래 SDK 콜백 결과 확인'):(commandErrors[v.error] || '차량 연결을 확인해 주세요.');}catch{document.getElementById('native-navigation-result').textContent='차량 연결을 확인해 주세요.';}finally{busy=false;await refresh();}});void refresh();setInterval(refresh,3000);
