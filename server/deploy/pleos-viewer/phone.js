const form = document.getElementById('phone-invite');
const input = document.getElementById('phone-invite-link');
const status = document.getElementById('phone-invite-status');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/vehicles/phone/invite', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invite: input.value.trim() })
    });
    if (response.status === 409) {
      status.textContent = 'PLY 차량 QR에서 복사한 초대 링크를 넣어 주세요.';
      return;
    }
    if (!response.ok) throw Error();
    input.value = '';
    status.textContent = 'Android에서 열었습니다. 게스트로 좌석을 신청하세요.';
  } catch {
    status.textContent = 'Android 연결을 확인해 주세요.';
  } finally { button.disabled = false; }
});
