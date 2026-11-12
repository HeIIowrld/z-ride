import { inJourney } from './journey.js';

const KEY = 'zride.passengerConfirmed';

export function ensurePassenger() {
  if (inJourney) return Promise.resolve(true);
  try { if (localStorage.getItem(KEY) === 'true') return Promise.resolve(true); } catch { /* Ask each session when storage is unavailable. */ }
  return new Promise(resolve => {
    let dialog = document.querySelector('#passenger-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.id = 'passenger-dialog';
      dialog.innerHTML = '<form method="dialog"><p class="eyebrow">안전 안내</p><h2>동승자입니다</h2><p>운전 중인 사람은 플레이하지 마세요.</p><button class="primary-button" value="confirm">확인하고 계속</button></form>';
      document.body.append(dialog);
    }
    const done = event => { const ok = event?.submitter?.value === 'confirm'; dialog.removeEventListener('close', closed); if (ok) try { localStorage.setItem(KEY, 'true'); } catch { /* Continue for this session. */ } resolve(ok); };
    const closed = () => done(null);
    dialog.addEventListener('close', closed, { once: true });
    dialog.querySelector('form').addEventListener('submit', done, { once: true });
    dialog.showModal();
  });
}
