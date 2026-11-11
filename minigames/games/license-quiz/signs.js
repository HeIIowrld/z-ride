const shapes = {
  bump: '<path d="M28 68h12q4-22 12 0h12q4-22 12 0h10"/><path d="M28 75h56"/>',
  children: '<circle cx="45" cy="43" r="7"/><circle cx="66" cy="46" r="6"/><path d="M45 50v20m-9-10h18m-9 10-8 10m8-10 7 10M66 52v17m-7-9h14m-7 9-6 9m6-9 6 9"/>',
  slippery: '<path d="M30 62h14l7-12 7 12h20"/><path d="M34 75c9-9 17 9 26 0s14 7 21 1"/>',
  rocks: '<path d="M36 72 48 53l9 9 8-20 18 30z"/><path d="M30 78h58"/>',
  right: '<path d="M39 75V55q0-12 12-12h23"/><path d="m65 34 10 9-10 9"/>',
  left: '<path d="M75 75V55q0-12-12-12H40"/><path d="m50 34-10 9 10 9"/>',
  uturn: '<path d="M66 76V49q0-15-15-15T36 49v4"/><path d="m28 48 8 9 8-9"/>',
  crosswalk: '<path d="M32 44h48M32 54h48M32 64h48M32 74h48"/>',
  stop: '<path d="M40 26h30l20 20v30L70 96H40L20 76V46z"/><path d="M40 40h30l7 7v28l-7 7H40l-7-7V47z"/>',
  camera: '<path d="M34 47h44v30H34zM43 47l5-8h16l5 8"/><circle cx="56" cy="62" r="8"/><path d="M78 52h8v16h-8M35 80l-5 8m43-8 5 8"/>',
  noentry: '<circle cx="56" cy="56" r="32"/><path d="M34 56h44"/>',
  speed: '<circle cx="56" cy="56" r="32"/><path d="M46 56h20M46 64h20"/>'
};
export function signSvg(key) {
  if (!key || !shapes[key]) return '';
  const warning = ['bump','children','slippery','rocks'].includes(key);
  const body = warning ? '<path d="M56 20 94 88H18z"/>' : key === 'stop' ? '' : '<circle cx="56" cy="56" r="38"/>';
  return `<svg viewBox="0 0 112 112" role="img" aria-label="교통 표지 그림" xmlns="http://www.w3.org/2000/svg"><g fill="white" stroke="#171717" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${body}${shapes[key]}</g></svg>`;
}
