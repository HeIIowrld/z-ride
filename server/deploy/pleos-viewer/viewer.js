import RFB from '/vehicles/novnc/core/rfb.js';

const id = location.pathname.match(/\/vehicles\/([123])\/?$/)?.[1];
const status = document.getElementById('status');
const title = document.getElementById('title');
const phone = /\/vehicles\/phone\/?$/.test(location.pathname);
const label = phone ? 'Android 동승자' : 'Pleos 차량 ' + id;
let rfb, connecting = false;

if (id || phone) title.textContent = label;
else status.textContent = '차량 주소를 확인해 주세요.';

async function connect() {
  if ((!id && !phone) || rfb || connecting) return;
  connecting = true;
  try {
    const response = await fetch('/vehicles/status.json', { cache: 'no-store' });
    if (!response.ok) throw Error();
    const { vehicles, phoneState } = await response.json();
    if (phone) {
      if (phoneState !== 'RUNNING') {
        status.textContent = phoneState === 'BOOTING' ? 'Android 동승자 부팅 중…'
          : '공유 Android 화면이 중지되어 있습니다. 차량 QR을 휴대폰으로 스캔해 참가할 수 있습니다.';
        return;
      }
    } else {
      document.getElementById('vehicle-list').hidden = vehicles.length <= 1;
      const vehicle = vehicles.find(candidate => candidate.id === id);
      if (!vehicle || vehicle.state === 'STOPPED') {
        status.textContent = '차량이 중지되어 있습니다.';
        return;
      }
      if (vehicle.state === 'BOOTING') {
        status.textContent = '차량 부팅 중…';
        return;
      }
    }
    status.textContent = '실시간 화면에 연결 중…';
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    rfb = new RFB(document.getElementById('screen'), `${protocol}//${location.host}/vehicles/ws/${phone ? 'phone' : id}`);
    rfb.viewOnly = false;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.showDotCursor = true;
    rfb.focusOnClick = true;
    rfb.addEventListener('connect', () => {
      status.dataset.connected = 'true';
      status.textContent = '실제 화면 연결됨 · 웹 조작 가능';
    });
    rfb.addEventListener('disconnect', () => {
      rfb = null;
      delete status.dataset.connected;
      status.textContent = '화면 연결이 끊겼습니다. 다시 연결 중…';
    });
  } catch {
    status.textContent = '차량 화면 연결을 확인하는 중…';
  } finally {
    connecting = false;
  }
}

void connect();
setInterval(connect, 5000);
window.addEventListener('pagehide', () => rfb?.disconnect());
