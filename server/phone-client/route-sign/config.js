'use strict';
// 경로 표지판(지도 위 아이템 표시)·도착 아이콘 설정.
//
// 아이콘 바꾸는 법:
//   1) 새 이미지(png / svg / webp / jpg)를 이 폴더(server/phone-client/route-sign/)에 넣는다.
//   2) 아래 icon(표지판) 또는 destinationIcon(도착) 값을 그 파일 이름으로 바꾼다.
//   3) 서버를 다시 시작한다(npm start). 이 폴더의 이미지는 서버가 자동으로 /play/route-sign/ 에서 제공한다.
window.PLY_ROUTE_SIGN = Object.freeze({
  icon: 'route-sign/sign-battery.png',      // 표지판 아이콘 (/play/ 기준 경로)
  size: 40,                                 // 평소 크기(px)
  readySize: 46,                            // 가까워져서 게임 가능할 때 크기(px)
  label: '경로 표지판',                       // 접근성 이름
  destinationIcon: 'route-sign/destination.svg', // 도착 아이콘
  destinationWidth: 28,                     // 도착 아이콘 폭(px). 높이는 비율 유지, 핀 끝이 도착 지점
});
