'use strict';
// 경로 표지판(지도 위 아이템 표시)·도착 아이콘 설정.
//
// 아이콘 바꾸는 법:
//   1) 새 이미지(png / svg / webp / jpg)를 이 폴더(server/phone-client/route-sign/)에 넣는다.
//   2) 아래 icon(표지판) 또는 destinationIcon(도착) 값을 그 파일 이름으로 바꾼다.
//   3) 서버를 다시 시작한다(npm start). 이 폴더의 이미지는 서버가 자동으로 /play/route-sign/ 에서 제공한다.
//
// 표지판마다 게임이 하나 정해지고(서버가 셔플해서 배정), 지도에는 그 게임의 아이콘(icons)이 나온다.
// icons에 없는 게임이면 icon(기본 아이콘)을 쓴다.
window.PLY_ROUTE_SIGN = Object.freeze({
  icon: 'route-sign/sign-battery.png',      // 기본 표지판 아이콘 (/play/ 기준 경로)
  icons: Object.freeze({                    // 게임별 표지판 아이콘
    'license-quiz': 'route-sign/sign-license-quiz.png',
    'pole-jump': 'route-sign/sign-pole-jump.png',
    raindrop: 'route-sign/sign-raindrop.png',
    zombie: 'route-sign/sign-zombie.png',    // 준비 중(게임 미연결)
  }),
  // 지도(journey-map.js)는 games에 있는 게임의 표지판만 그린다. 보상 기록(app.js)도 label·icon을 쓴다.
  games: Object.freeze({
    'license-quiz': Object.freeze({ label: '운전면허 퀴즈', icon: 'route-sign/sign-license-quiz.png' }),
    'pole-jump': Object.freeze({ label: '폴짝 전봇대', icon: 'route-sign/sign-pole-jump.png' }),
    raindrop: Object.freeze({ label: '빗방울 캐치', icon: 'route-sign/sign-raindrop.png' }),
    zombie: Object.freeze({ label: 'DEADZONE', icon: 'route-sign/sign-zombie.png' }),
  }),
  size: 40,                                 // 평소 크기(px)
  readySize: 46,                            // 가까워져서 게임 가능할 때 크기(px)
  label: '경로 표지판',                       // 접근성 이름
  destinationIcon: 'route-sign/destination.svg', // 도착 아이콘
  destinationWidth: 28,                     // 도착 아이콘 폭(px). 높이는 비율 유지, 핀 끝이 도착 지점
});
