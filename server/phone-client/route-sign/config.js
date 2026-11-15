'use strict';
// 이미지 경로는 /play/ 기준이다. 교체 절차는 server/docs/route-signs.md에 있다.
window.PLY_ROUTE_SIGN = Object.freeze({
  icon: 'route-sign/sign-battery.png',
  icons: Object.freeze({
    'license-quiz': 'route-sign/sign-license-quiz.png',
    'pole-jump': 'route-sign/sign-pole-jump.png',
    raindrop: 'route-sign/sign-raindrop.png',
    zombie: 'route-sign/sign-zombie.png',
  }),
  // 지도는 games에 등록된 표지판만 그린다. 보상 기록도 여기에서 이름과 아이콘을 읽는다.
  games: Object.freeze({
    'license-quiz': Object.freeze({ label: '운전면허 퀴즈', icon: 'route-sign/sign-license-quiz.png' }),
    'pole-jump': Object.freeze({ label: '폴짝 전봇대', icon: 'route-sign/sign-pole-jump.png' }),
    raindrop: Object.freeze({ label: '빗방울 캐치', icon: 'route-sign/sign-raindrop.png' }),
    zombie: Object.freeze({ label: 'DEADZONE', icon: 'route-sign/sign-zombie.png' }),
  }),
  size: 40,
  readySize: 46,
  label: '경로 표지판',
  destinationIcon: 'route-sign/destination.svg',
  destinationWidth: 28,
});
