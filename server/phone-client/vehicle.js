'use strict';
(() => {
  const $=id=>document.getElementById(id),origin=window.GAME_CONFIG?.apiOrigin||location.origin;
  let credential=null,room=null,ws=null,authenticated=false,reportSeq=0,timer=null,invite=null,busy=false,closed=false,phase='',lastMembers='',configReady=false;
  const notify=stage=>{if(stage!==phase){phase=stage;if(window.parent!==window)window.parent.postMessage({type:'mock:vehicle',stage},location.origin);}};
  function log(text){const row=document.createElement('li');row.textContent=new Date().toLocaleTimeString()+' · '+text;$('host-log').prepend(row);while($('host-log').children.length>25)$('host-log').lastChild.remove();}
  function status(text){$('host-status').textContent=text;}
  function error(e){$('host-error').textContent='처리하지 못함 · '+(/^[A-Z0-9_]+$/.test(e.message)?e.message:'연결을 확인해 주세요');}
  async function api(path,body,token=credential){
    const r=await fetch(new URL(path,origin),{method:'POST',cache:'no-store',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
    const data=await r.json();log('POST '+path.replace(/\/rooms\/[^/]+/,'/rooms/:roomId')+' → '+r.status);
    if(!r.ok)throw new Error(data.error?.code||'HTTP_'+r.status);return data;
  }
  async function act(fn){if(busy)return;busy=true;$('host-error').textContent='';render();try{await fn();}catch(e){error(e);}finally{busy=false;render();}}
  function report(){if(!authenticated||ws?.readyState!==WebSocket.OPEN||closed)return;
    ws.send(JSON.stringify({type:'vehicle.report',commandId:crypto.randomUUID(),reportSeq:++reportSeq,ux:'ALLOWED',gear:$('host-gear').value,foreground:!document.hidden,seats:[],source:'SIMULATED_API_CLIENTS'}));
  }
  function render(){
    $('host-create').disabled=busy||authenticated||!configReady;$('host-create').textContent=room&&!closed?'차량 다시 연결':'차량 연결 · 파티 생성';
    $('host-form').hidden=authenticated;$('host-party').hidden=!room||closed;
    $('invite-renew').disabled=busy||!authenticated;$('host-start').disabled=busy||!authenticated||$('host-gear').value!=='P';$('host-close').disabled=busy;
    if(!room)return;
    const members=room.members.filter(m=>m.role!=='CAR_HOST');
    const memberKey=JSON.stringify([members.map(m=>[m.memberId,m.nickname,m.seat,m.approved,m.connected]),busy,authenticated]);
    if(memberKey!==lastMembers){lastMembers=memberKey;$('host-members').replaceChildren(...members.map(member=>{
      const li=document.createElement('li'),text=document.createElement('span');text.textContent=member.nickname+' · '+member.seat+' · '+(member.approved?'승인됨':'승인 대기')+' · '+(member.connected?'연결됨':'오프라인');li.append(text);
      if(!member.approved){const button=document.createElement('button');button.type='button';button.className='quiet';button.textContent='이 좌석 승인';button.disabled=busy||!authenticated;button.addEventListener('click',()=>act(async()=>{const data=await api('/api/rooms/'+room.roomId+'/approve',{memberId:member.memberId,seat:member.seat,allowManualUnknown:true});room=data.room;notify('APPROVED');}));li.append(button);}
      return li;
    }));}
    $('host-summary').textContent=`폰 ${members.length}명 · 승인 ${members.filter(m=>m.approved).length}명 · 공동 보급 ${room.collection?.inventory?.supplies??0}개 · ${room.state}`;
    if(closed)notify('CLOSED');else if(members.some(m=>m.approved&&m.connected))notify('CONNECTED');else if(members.some(m=>!m.approved))notify('REQUESTED');else if(members.some(m=>m.approved))notify('APPROVED');
  }
  function connect(){return new Promise((resolve,reject)=>{
    if(ws){ws.onclose=null;ws.close();}authenticated=false;reportSeq=0;
    const pending=setTimeout(()=>{ws.close();reject(new Error('WS_TIMEOUT'));},10000);
    ws=new WebSocket(origin.replace(/^http/,'ws')+'/ws');
    ws.onopen=()=>ws.send(JSON.stringify({type:'auth',token:credential,roomId:room.roomId}));
    ws.onmessage=event=>{let message;try{message=JSON.parse(event.data);}catch{return;}
      if(message.type==='auth.ok'){clearTimeout(pending);authenticated=true;status('차량이 서버의 같은 파티에 연결됐음 · SIMULATED_NO_SDK');log('WS auth → auth.ok');report();render();resolve();}
      if(message.type==='snapshot'){room=message.room;render();}
      if(message.type==='result'&&!message.ok)error(new Error(message.error?.code||'COMMAND_REJECTED'));
      if(message.type==='error')error(new Error(message.error?.code||'WS_REJECTED'));
    };
    ws.onerror=()=>{clearTimeout(pending);reject(new Error('WS_CONNECTION_FAILED'));};
    ws.onclose=()=>{clearTimeout(pending);authenticated=false;status(closed?'차량 파티 해산됨':'차량 연결이 끊김. 다시 연결 버튼을 눌러 주세요.');render();reject(new Error('WS_DISCONNECTED'));};
  });}
  async function issueInvite(){
    const data=await api('/api/rooms/'+room.roomId+'/party/invite',{}),url=new URL(data.joinUrl);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('INVALID_INVITE_URL');
    const qr=qrcode(0,'M');qr.addData(data.joinUrl,'Byte');qr.make();
    const modules=qr.getModuleCount(),cell=6,size=(modules+8)*cell,canvas=$('invite-qr');canvas.width=size;canvas.height=size;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,size,size);ctx.fillStyle='#000';
    for(let y=0;y<modules;y++)for(let x=0;x<modules;x++)if(qr.isDark(y,x))ctx.fillRect((x+4)*cell,(y+4)*cell,cell,cell);
    invite=data;$('invite-link').href=url.href;$('invite-link').hidden=false;canvas.hidden=false;
    notify('QR_READY');if(window.parent!==window)window.parent.postMessage({type:'mock:invite',joinUrl:data.joinUrl},location.origin);
    log('QR → 폰 초대 URL (120초, HOST 토큰 제외)');
  }
  $('host-form').addEventListener('submit',event=>{event.preventDefault();void act(async()=>{
    if(!room||closed){const session=await api('/api/session',{role:'CAR_HOST',nickname:$('host-name').value.trim(),accessKey:$('host-key').value},null);credential=session.token;$('host-key').value='';
      const data=await api('/api/rooms',{});room=data.room;closed=false;notify('ROOM_READY');}
    await connect();if(!invite||Date.now()>=invite.expiresAt)await issueInvite();
  });});
  $('invite-renew').addEventListener('click',()=>act(issueInvite));
  $('host-gear').addEventListener('change',report);document.addEventListener('visibilitychange',report);
  $('host-start').addEventListener('click',()=>{if(authenticated)ws.send(JSON.stringify({type:'command',commandId:crypto.randomUUID(),roomEpoch:room.roomEpoch,action:'round.start'}));});
  $('host-close').addEventListener('click',()=>act(async()=>{await api('/api/rooms/'+room.roomId+'/party/disband',{});closed=true;authenticated=false;credential=null;invite=null;$('invite-link').hidden=true;$('invite-link').removeAttribute('href');$('invite-qr').hidden=true;ws?.close();notify('CLOSED');status('차량 파티 해산됨');}));
  timer=setInterval(()=>{report();if(invite){const seconds=Math.max(0,Math.ceil((invite.expiresAt-Date.now())/1000));$('invite-ttl').textContent=seconds?seconds+'초 남음':'만료 · 새 QR 발급 필요';if(!seconds){$('invite-qr').hidden=true;$('invite-link').hidden=true;}}},2000);
  window.addEventListener('pagehide',()=>{clearInterval(timer);ws?.close();});
  window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
  render();
  void (async()=>{try{const response=await fetch(new URL('/api/client-config',origin),{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('CONFIG_UNAVAILABLE');const config=await response.json();const required=config.sessionAccessKeyRequired!==false;$('host-key-label').hidden=!required;$('host-key').required=required;configReady=true;status(required?'차량 테스트 접근키를 입력해 주세요.':'공개 시연 · 접근키 없이 차량 파티를 만들 수 있음.');render();}catch(e){error(e);}})();
})();
