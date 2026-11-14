'use strict';
// Account credentials are separate from short-lived party-play credentials.
(() => {
  const $ = id => document.getElementById(id);
  const origin = window.GAME_CONFIG?.apiOrigin || location.origin;
  const storageKey = 'phone-account-v1:' + origin;
  let token = null, account = null, config = null, invite = null, preview = null;
  let busy = false, polling = false, legacy = false, googleReady = false, authGeneration = 0, inviteGeneration = 0, watch = null, googleTimer = null, sdkPromise;
  const message = value => { $('account-error').textContent = value; };
  const notify = name => window.dispatchEvent(new CustomEvent(name));
  function save() { try { if (token) sessionStorage.setItem(storageKey, token); else sessionStorage.removeItem(storageKey); } catch { message('세션 저장소를 사용할 수 없어 새로고침하면 다시 로그인해야 함.'); } }
  async function api(path, body, credential = token) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    try {
      const r = await fetch(new URL(path, origin), {method: body === undefined ? 'GET' : 'POST', cache:'no-store', signal:controller.signal,
        headers:{...(body === undefined ? {} : {'content-type':'application/json'}), ...(credential ? {authorization:'Bearer '+credential} : {})},
        body:body === undefined ? undefined : JSON.stringify(body)});
      const data = await r.json();
      if (!r.ok) throw Object.assign(new Error(data.error?.code || 'HTTP_'+r.status), {status:r.status});
      return data;
    } finally { clearTimeout(timer); }
  }
  const descriptions = {
    ACCOUNT_AUTH_REQUIRED:'로그인이 만료됨. Google로 다시 로그인하거나 새 게스트로 시작해 주세요. 기존 게스트를 자동으로 덮어쓰지 않음.',
    AUTH_CHALLENGE_EXPIRED:'로그인 준비 시간이 지남. Google 로그인을 다시 눌러 주세요.',
    ACCOUNT_LINK_CONFLICT:'다른 계정에 이미 연결된 Google 계정임. 현재 게스트 기록은 유지됨. 기존 계정으로 로그인하려면 먼저 로그아웃해 주세요.',
    PARTY_SWITCH_CONFLICT:'다른 기기에서 파티 상태가 바뀜. 화면을 새로고침하고 다시 확인해 주세요.',
    PENDING_JOIN_EXISTS:'이미 차량 승인을 기다리고 있음. 현재 요청을 확인해 주세요.',
    ALREADY_IN_PARTY:'이미 참가한 파티임. 현재 파티 화면 연결을 눌러 주세요.',
    INVITE_EXPIRED:'QR이 만료됨. 차량에서 새 QR을 받아 주세요.',
    AUTH_PROVIDER_DISABLED:'Google 로그인 설정을 준비 중임. 게스트로 참가할 수 있음.',
    INVALID_NICKNAME:'닉네임을 1~24자로 입력해 주세요.',
  };
  function error(e) { message(descriptions[e.message] || '요청을 완료하지 못함 · '+(/^[A-Z0-9_]+$/.test(e.message) ? e.message : '연결을 확인해 주세요')); }
  const seatChoice = $('seat');
  const positions = $('crew-positions');
  const seatButtons = [...positions.querySelectorAll('[data-seat]')];
  function renderSeats() {
    const available = preview ? (preview.joinable ? preview.availableSeats : []) : null;
    positions.hidden = !(preview && account) && !legacy;
    if (available && !available.includes(seatChoice.value)) {
      seatChoice.selectedIndex = -1;
    }
    for (const button of seatButtons) {
      const open = !available || available.includes(button.dataset.seat);
      const selected = open && seatChoice.value === button.dataset.seat;
      button.disabled = !open;
      button.setAttribute('aria-pressed', String(selected));
      button.querySelector('span').textContent = selected ? '내 자리' : open ? '빈 자리' : '사용 중';
    }
  }
  seatChoice.selectedIndex = -1;
  seatChoice.addEventListener('change', () => { renderSeats(); $('form-error').textContent = ''; });
  for (const button of seatButtons) button.addEventListener('click', () => {
    seatChoice.value = button.dataset.seat;
    seatChoice.dispatchEvent(new Event('change'));
  });
  function render() {
    const game = $('game');
    $('account-panel').hidden = game.hidden ? !invite && !token && !account : $('approved-content').hidden;
    $('account-signin').hidden = !!account;
    $('account-status').textContent = account ? `${account.displayName} · ${account.kind === 'GOOGLE' ? 'Google' : '게스트'}${account.activePartyId ? ' · '+(account.activePartyName || '참가 중인 차량') : ''}${account.pendingPartyId ? ' · 새 차량 승인 대기' : ''}` : '게스트로 시작한 뒤 바로 합류할 수 있어요.';
    $('guest-button').disabled = busy || !config;
    $('google-start').hidden = account?.kind === 'GOOGLE' || googleReady;
    $('google-start').disabled = busy || !config?.auth?.google?.enabled;
    $('google-start').textContent = account ? 'Google 연결 · 게스트 기록 유지' : 'Google 로그인';
    $('account-resume').hidden = !account?.activePartyId;
    $('account-cancel').hidden = !account?.pendingPartyId;
    $('account-logout').hidden = !account;
    for (const id of ['account-resume','account-cancel','account-logout']) $(id).disabled = busy;
    $('switch-label').hidden = !preview?.requiresVehicleSwitch;
    $('invite-status').textContent = preview ? `${preview.partyName || '차량 파티'} · ${preview.joinable ? '차량 승인 후 참가' : '빈자리 없음'}` : invite ? '초대 확인 중…' : '';
    renderSeats();
  }
  function setAccount(data) { token = data.accountToken; account = data.account; save(); render(); }
  async function refresh() { const data = await api('/api/me'); account = data.account; render(); return account; }
  async function checkInvite() {
    const current = ++inviteGeneration; preview = null; $('switch-confirm').checked = false; render();
    if (!invite) return;
    try { const data = await api('/api/invites/preview', {inviteToken:invite}); if (current !== inviteGeneration) return; preview = data; render(); }
    catch(e) { if (current !== inviteGeneration) return; $('invite-status').textContent = 'QR을 사용할 수 없음. 차량에서 새 QR을 받아 주세요.'; error(e); }
  }
  function readInvite() {
    const cap = new URLSearchParams(location.hash.slice(1)).get('invite');
    if (!cap) return;
    invite = cap; history.replaceState(null,'',location.pathname+location.search);
    legacy = false; $('legacy-fields').hidden = true; $('nickname').required = false; $('join-code').required = false;
    $('legacy-toggle').hidden = true;
    $('login-panel').hidden = false; $('game').hidden = true;
    $('join-description').textContent = '앉은 자리를 선택하면 Pleos로 합류 요청을 보냅니다.';
    seatChoice.selectedIndex = -1;
    if (config) void checkInvite();
  }
  function ticket(data) { window.dispatchEvent(new CustomEvent('phone:ticket', {detail:data})); }
  async function resume() { ticket(await api('/api/me/party-ticket', {})); }
  async function pollApproval() {
    if (!account?.pendingPartyId || busy || polling || document.hidden) return;
    polling = true;
    const expected = account.pendingPartyId, generation = authGeneration;
    try {
      const data = await api('/api/me'); if (generation !== authGeneration) return;
      account = data.account; render();
      if (!account.pendingPartyId && account.activePartyId === expected) { invite = null; preview = null; render(); await resume(); }
    } catch(e) { if (generation === authGeneration) error(e); } finally { polling = false; }
  }
  async function action(fn) {
    if (busy) return; busy = true; message(''); render();
    try { await fn(); } catch(e) { error(e); } finally { busy = false; render(); }
  }
  function loadGoogle() {
    if (window.google?.accounts?.id) return Promise.resolve();
    if (!sdkPromise) sdkPromise = new Promise((resolve,reject) => {
      const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
      const timer = setTimeout(() => { script.remove(); sdkPromise = null; reject(new Error('GOOGLE_SDK_TIMEOUT')); }, 15000);
      script.onload = () => { clearTimeout(timer); resolve(); }; script.onerror = () => { clearTimeout(timer); script.remove(); sdkPromise = null; reject(new Error('GOOGLE_SDK_UNAVAILABLE')); };
      document.head.append(script);
    });
    return sdkPromise;
  }
  function clearGoogle() { clearTimeout(googleTimer); googleReady = false; $('google-button').replaceChildren(); }
  $('google-start').addEventListener('click', () => action(async () => {
    clearGoogle(); const generation = ++authGeneration, sourceToken = token;
    const challenge = await api('/api/auth/google/challenge', {mode:account ? 'LINK' : 'LOGIN'});
    await loadGoogle();
    if (generation !== authGeneration) return;
    window.google.accounts.id.initialize({client_id:challenge.clientId, nonce:challenge.nonce, ux_mode:'popup', auto_select:false,
      callback: response => {
        if (generation !== authGeneration || sourceToken !== token) return;
        void action(async () => {
          clearGoogle();
          const data = await api('/api/auth/google/exchange', {challengeId:challenge.challengeId, credential:response.credential}, sourceToken);
          setAccount(data); ++authGeneration; notify('phone:reset'); await checkInvite();
        });
      }});
    window.google.accounts.id.renderButton($('google-button'), {type:'standard',theme:'outline',size:'large',text:account ? 'continue_with' : 'signin_with',width:260});
    googleReady = true;
    googleTimer = setTimeout(() => { if (generation === authGeneration) { ++authGeneration; clearGoogle(); render(); message('로그인 준비 시간이 지남. Google 로그인을 다시 눌러 주세요.'); } }, Math.max(1,challenge.expiresAt-Date.now()));
  }));
  $('guest-button').addEventListener('click', () => action(async () => {
    ++authGeneration; clearGoogle(); const nickname = $('account-nickname').value.trim();
    if (!nickname || nickname.length > 24) throw new Error('INVALID_NICKNAME');
    setAccount(await api('/api/accounts/guest', {nickname}, null)); await checkInvite();
  }));
  $('account-resume').addEventListener('click', () => action(async () => { await refresh(); await resume(); }));
  $('account-cancel').addEventListener('click', () => action(async () => {
    const data = await api('/api/me/invitations/cancel', {}); account = data.account; notify('phone:reset'); await checkInvite();
  }));
  $('account-logout').addEventListener('click', () => action(async () => {
    try { await api('/api/accounts/logout', {}); } catch(e) { if (e.status !== 401) throw e; }
    ++authGeneration; clearGoogle(); token = null; account = null; save(); notify('phone:reset'); await checkInvite();
  }));
  $('legacy-toggle').addEventListener('click', () => {
    legacy = !legacy; $('legacy-fields').hidden = !legacy;
    $('nickname').required = legacy; $('join-code').required = legacy;
    $('legacy-toggle').textContent = legacy ? 'QR 참가로 돌아가기' : '테스트 참가 코드';
    renderSeats();
  });
  window.PHONE_ACCOUNT = {
    isAccountMode: () => !legacy,
    hasSession: () => !!token,
    async join(seat, passengerConfirmed) {
      if (busy) throw new Error('ACCOUNT_BUSY');
      if (!token || !account) throw new Error('ACCOUNT_AUTH_REQUIRED');
      if (!invite || !preview) throw new Error('VEHICLE_QR_REQUIRED');
      busy = true; render();
      try {
        await refresh();
        const joined = await api('/api/me/invitations/accept', {inviteToken:invite,seat,passengerConfirmed,
          expectedActivePartyId:preview.activePartyId,confirmSwitch:$('switch-confirm').checked});
        account = joined.account; return joined;
      } finally { busy = false; render(); }
    },
    async leave(pending = false) { const data = await api(pending ? '/api/me/invitations/cancel' : '/api/me/party/leave', {}); account = data.account; render(); },
    sync: () => action(async () => { await refresh(); }),
    render,
  };
  readInvite(); window.addEventListener('hashchange',readInvite);
  void (async () => {
    try {
      config = await api('/api/client-config', undefined, null);
      try { token = sessionStorage.getItem(storageKey); } catch {}
      if (token) {
        try { setAccount(await api('/api/accounts/refresh', {})); }
        catch(e) { if (e.status === 401) { token = null; account = null; save(); } error(e); }
      }
      await checkInvite();
    } catch(e) { error(e); } finally { render(); }
    watch = setInterval(pollApproval,3000);
  })();
  window.addEventListener('pagehide', () => { clearInterval(watch); });
  window.addEventListener('pageshow', event => { if (event.persisted) { clearInterval(watch); watch = setInterval(pollApproval,3000); void pollApproval(); } });
})();
