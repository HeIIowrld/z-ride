'use strict';
(() => {
  const $=id=>document.getElementById(id),vehicle=$('vehicle-frame'),phone=$('phone-frame');
  let phoneInParty=false;
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||!event.data||typeof event.data!=='object')return;
    const data=event.data;
    if(event.source===phone.contentWindow&&data.type==='mock:phone-party'){
      phoneInParty=data.joined===true;return;
    }
    if(event.source===vehicle.contentWindow&&data.type==='mock:invite'){
      try{const url=new URL(data.joinUrl);if(url.origin!==location.origin||!['/play','/play/'].includes(url.pathname)||url.username||url.password||url.search||url.hash.length>160)return;
        if(phoneInParty)return;
        phone.src=url.href;$('step-room').className='done';$('step-qr').className='done';
        for(const id of ['step-phone','step-connected'])$(id).className='';
        $('demo-status').textContent='QR 발급 완료. 오른쪽 폰에서 로그인 후 좌석을 선택해 합류하세요.';
      }catch{}return;
    }
    if(event.source===vehicle.contentWindow&&data.type==='mock:vehicle'){
      if(data.stage==='REQUESTED'){$('step-phone').className='done';$('demo-status').textContent='참가 요청을 받았습니다. 차량 화면에서 해당 좌석을 승인해 주세요.';}
      if(data.stage==='APPROVED'){$('step-phone').className='done';$('demo-status').textContent='좌석 선택 완료. 동승자 연결을 기다리는 중…';}
      if(data.stage==='CONNECTED'){$('step-phone').className='done';$('step-connected').className='done';$('demo-status').textContent='차량과 동승자가 연결됐습니다. 동승자 화면에서 여정을 이어가세요.';}
      if(data.stage==='CLOSED'){phoneInParty=false;phone.src='/play';$('demo-status').textContent='여정이 끝났습니다. 차량에서 새 파티를 만들 수 있습니다.';for(const id of ['step-room','step-qr','step-phone','step-connected'])$(id).className='';}
    }
  });
})();
