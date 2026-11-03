# 웹 차량 화면 (`/play/car`)

2026-11-03. 앱 팀(차량 QR·호스트 UI) 작업. 서버 계약은 바꾸지 않았다. Pleos 앱을 붙이기 전, 노트북 브라우저를 차량 화면 대신 쓰는 시험판이다.

## 흐름

1. `/play/car`에서 **파티 열기** → `POST /api/session {role:'CAR_HOST'}` → `POST /api/rooms`
2. WebSocket 인증 뒤 2초마다 `vehicle.report`를 보낸다. 기어는 화면의 **P 주차 / D 주행** 버튼으로 고른다(`source: 'WEB_CAR_SIMULATED'`). P일 때만 `ux: ALLOWED`.
3. `POST /api/rooms/{roomId}/party/invite`로 받은 `joinUrl`을 **페이지 안에서 QR로 그린다**(`qr.js`). 초대 링크를 외부 QR 서비스로 보내지 않는다.
   - 120초 카운트다운. 만료되면 빈자리가 있을 때만 새 QR을 받는다.
   - 세 자리가 다 차면 QR을 치운다. 누가 나가면 새 QR을 받는다.
   - **새 QR**, **QR 숨기기** 버튼.
4. 폰이 QR을 찍으면 기존 `/play#invite=…` 경로로 닉네임·좌석·동승자 확인 후 참가 요청 → 차량 화면 **탐험대원** 목록에 "승인 대기"로 뜨고 **승인 / 내보내기** 버튼이 생긴다. 시험용 자동 승인 체크박스도 있다.
5. **공동 전투** 카드: 남은 좀비·보급품·처치 수, `round.start`(완료 뒤에는 "다음 웨이브 시작") / `round.pause` / `support.pulse`. 주행(D) 중에는 게임 정보를 가린다.
6. **파티 해산**(`party/disband`)은 HOST만 가능하다. 해산 후 옛 QR은 다시 쓸 수 없다.

차량은 합류·승인·보급품·공략 완료 때 짧은 효과음만 낸다(WebAudio). 게임 화면은 폰에만 있다.

## 실행

`ZRIDE_PUBLIC_ORIGIN`이 없으면 서버가 초대 링크를 만들지 않는다(`PUBLIC_ORIGIN_REQUIRED`). 폰이 노트북에 접속할 수 있는 주소를 넣는다.

```sh
cd server
ZRIDE_PUBLIC_ORIGIN=http://$(ipconfig getifaddr en0):8000 HOST=0.0.0.0 npm start
```

- 노트북: `http://localhost:8000/play/car`
- 폰: 같은 Wi-Fi에서 카메라로 QR 촬영

초대 URL·QR 화면을 공개 게시물·단톡방에 올리지 않는다(현재 일행에게만 보여 준다).

## 파일

| 파일 | 내용 |
| --- | --- |
| `phone-client/car.html` · `car.js` · `car.css` | 웹 차량 화면 |
| `phone-client/qr.js` | 외부 의존성 없는 QR 생성기(바이트 모드, 오류 정정 M, 버전 1~40, 마스크 자동) → SVG |
| `phone-client.mjs` | 위 파일을 정적 허용 목록에 추가, `/play/car` 경로 |

CSP(`script-src 'self'`, `style-src 'self'`)를 지킨다. CDN·외부 이미지 없음.

## 검증

- `node --test test/phone-client.test.mjs` 통과(새 정적 경로 포함)
- QR: 생성한 SVG를 OpenCV로 디코딩해 원래 초대 URL과 일치 확인(모든 마스크)
- 실제 서버 + 헤드리스 Chrome으로 처음부터 끝까지:
  차량 파티 열기 → QR 화면 캡처를 디코딩한 URL로 폰 3대 참가 → 차량에서 승인 → 전투 시작 → 각 폰이 자기 구역 좀비 사격 → `공략 완료`·남은 좀비 0/3·처치 3 → 세 자리 찬 동안 QR 숨김 → 1명 탈퇴 시 새 QR 표시(2/3). 페이지 오류 없음.
- 실제 Pleos AVD·실물 폰 카메라 시험은 사용자 노트북에서 한다.

## 실물 아이폰 시험에서 고친 것 (2026-11-04)

- **QR을 다시 찍으면 대원이 하나 더 생김**: 카메라가 여는 새 탭은 `sessionStorage`를 이어받지 못한다. 폰 세션을 `localStorage`에 두어 같은 자리로 다시 붙는다(탈퇴·해산·인증 만료·`NOT_MEMBER`·`PARTY_CLOSED` 때 지움, `4409`는 다른 탭이 이어받은 것이므로 남김).
- **승인 시 `SEAT_TAKEN`**: 같은 자리에 오프라인으로 남은 옛 대원이 있으면 차량 화면이 먼저 내보내고 승인한다.
- **시간이 남았는데 QR이 안 됨**: 초대 하나는 참가 3번까지만 받는다(재시도 포함). 누가 들어오거나 내보내질 때마다 새 QR을 받는다.
- **폰이 "방 연결 중…"에서 멈춤**: 아이폰 Safari에서 WebSocket이 열리지도 실패하지도 않은 채 멈출 때가 있다. 8초 안에 `auth.ok`가 없으면 버리고 다시 연결하고, 화면 복귀·`online`·`pageshow` 때도 열려 있지 않은 연결은 다시 붙인다.
- **두 번 탭하면 확대된 채로 남음**: 페이지에 `touch-action: manipulation`, viewport `maximum-scale=1`. 확대된 채 전투 화면이 열리면 원래 비율로 되돌린다.

## 다음

- Pleos 앱(Android)으로 옮길 때: 기어는 Vehicle SDK 신호로, QR은 같은 `joinUrl`을 앱 화면에 그리면 된다.
