'use strict';
(() => {
  const $=id=>document.getElementById(id),vehicle=$('vehicle-frame'),phone=$('phone-frame');
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||!event.data||typeof event.data!=='object')return;
    const data=event.data;
    if(event.source===vehicle.contentWindow&&data.type==='mock:invite'){
      try{const url=new URL(data.joinUrl);if(url.origin!==location.origin||!['/play','/play/'].includes(url.pathname)||url.username||url.password||url.search||url.hash.length>160)return;
        phone.src=url.href;$('step-room').className='done';$('step-qr').className='done';
        for(const id of ['step-phone','step-approval','step-connected'])$(id).className='';
        $('demo-status').textContent='QR 발급 완료. 오른쪽 폰에서 로그인 후 좌석 참가 요청을 보내 주세요.';
      }catch{}return;
    }
    if(event.source===vehicle.contentWindow&&data.type==='mock:vehicle'){
      if(data.stage==='REQUESTED'){$('step-phone').className='done';$('demo-status').textContent='참가 요청 수신. 왼쪽 차량 화면에서 해당 좌석을 승인해 주세요.';}
      if(data.stage==='APPROVED'){$('step-approval').className='done';$('demo-status').textContent='차량 승인 완료. 폰의 파티 연결을 기다리는 중…';}
      if(data.stage==='CONNECTED'){$('step-phone').className='done';$('step-approval').className='done';$('step-connected').className='done';$('demo-status').textContent='승인된 폰과 차량이 같은 파티에 연결됐음. 양쪽 화면에서 보급품과 참가자를 확인할 수 있음.';}
      if(data.stage==='CLOSED'){$('demo-status').textContent='차량 파티가 해산됐음. 새 파티를 만들어 다시 확인할 수 있음.';for(const id of ['step-room','step-qr','step-phone','step-approval','step-connected'])$(id).className='';}
    }
  });
})();
