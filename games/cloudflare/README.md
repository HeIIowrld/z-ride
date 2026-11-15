# 충전 게임 4종 · Cloudflare 배포

충전 릴레이, Power Tug, Volt Rush, Power Castle을 Cloudflare Workers + Durable Objects로 돌린다. DEADZONE처럼 게임은 따로 배포하고, PLY 서버와 차량 앱은 주소만 받아 연결하는 방식이다.

## 구조
- `worker.mjs`: Worker(정적 파일, 방 만들기·참가 API, WebSocket 연결)와 `Room` Durable Object(방 하나 = 객체 하나, 이름은 방 코드). 방 상태·타이머·WebSocket을 객체 안에서 들고 있는다.
- `adapters.mjs`: 게임마다 다른 부분(메시지 처리, 다음에 깨어날 시각). 규칙은 각 게임 폴더의 `game.mjs`를 그대로 import한다.
- `build.mjs`: `dist/<게임>/`에 정적 파일 + `games/sdk/zride-car.js` + `wrangler.jsonc`를 만든다. 게임마다 Worker를 하나씩 배포한다(`zride-<게임>`).
- 폰·차 화면은 WebSocket을 `/ws?room=<코드>`로 연다(Node 서버는 쿼리를 무시하므로 둘 다 동작).

## 실행
```bash
npm install
npm run build
GAME=power-castle npm run dev     # 로컬 시험(wrangler dev)
npm run deploy                     # 4종 배포(Cloudflare 로그인 필요)
```

## 진행 상황
- [x] 공통 Durable Object 방, 게임별 어댑터, 빌드 스크립트
- [x] 클라이언트 WebSocket 주소에 방 코드 추가(4종)
- [x] `wrangler dev`로 로컬 시험: 4종 모두 방 만들기·참가·잘못된 토큰 차단·규칙→경기 시작 확인, Power Castle은 번개 도착까지 확인
- [x] 배포: 4종 + 게임 모음 화면(zride-charge-hub)을 workers.dev에 올리고 공개 주소로 방 만들기·참가·경기 시작 확인
- [ ] PLY 서버에 충전 게임 주소 설정 추가, carapp 충전 메뉴를 4종으로 교체(PR)

## 어디서 열리나
- **기본은 PLY 서버가 4종을 직접 띄운다**(`server/charge-games.mjs`, `/charge/<게임>/`). 한 컴퓨터 시연은 `server/`에서 `npm start`만 하면 되고 이 Worker 배포가 필요 없다. 방 로직은 아래 Worker의 `Room`과 같고, 규칙은 같은 `adapters.mjs`·각 게임 `game.mjs`를 쓴다. 이 Worker 배포판은 PLY 서버의 `GAME_CHARGE_GAMES`로 고른 게임, 또는 게임 파일이 없는 옛 배포에서만 쓴다.
- PLY 차량 앱(carapp) 충전 메뉴의 4종(Power Castle, Volt Rush, Power Tug, 충전 릴레이)은 PLY 서버가 준 주소를 `ChargeGameActivity`로 연다. 서버에 충전 게임 연결이 꺼져 있을 때만 이 Cloudflare 배포판을 바로 연다.
- **PLY 파티 연동(DEADZONE과 같은 방식)**: 차량 앱이 PLY 서버에 `POST /api/rooms/{roomId}/charge-game {action:'open'}`을 보내면, 서버가 게임 방(기본은 서버 안, 설정하면 이 Worker)을 만들고 승인된 크루를 미리 참가시킨다. 차 화면은 `#host=` 입장권 주소로, 크루 폰은 PLY 폰 화면의 "입장" 버튼(`#join=` 개인 입장권)으로 이름 입력·QR 없이 들어온다. 파티 보급품은 PLY 서버가 관리하고(`action:'item'`), 충전 릴레이는 그걸로 판마다 한 번 15초를 늘린다.
- PLY 서버에 이 연결이 꺼져 있으면(`GAME_CHARGE_GAMES=off`) 차량 앱은 게임 주소를 바로 열고 QR로 참가한다.
- 방 코드·입장권·참가자는 Durable Object 저장소에 남긴다. 아무도 접속하지 않아 메모리에서 내려갔다가 다시 불려도 같은 입장권으로 들어온다. 방은 6시간 뒤 지운다. 없는 방이면 WebSocket을 4404로 닫아 화면이 "방이 닫혔어요"를 띄운다.
- PLY 서버의 옛 충전소 게임(`server/venue-electric-thief.mjs`, `server/venue-charge-relay.mjs`, `/venue-game` API)은 차량 앱에서 더 이상 열지 않는다. 서버 쪽 정리는 서버 담당이 따로 한다.
- 전기도둑은 없앴다(`games/electric-thief` 삭제, 차량 앱 메뉴에서 제거).

### PLY Volt Rush 운영 경로

Volt Rush는 기존 PLY HTTPS의 `/volt-rush/`에서 같은 Worker 런타임으로 서비스할 수 있다. 정적 파일·API·WebSocket 경로를 해당 prefix에서 Worker 루트로 전달한다. PLY의 `GAME_CHARGE_GAMES`는 Volt Rush 주소를 가리키고, Worker의 `PLY_ITEMS_ORIGIN`은 크루 재고를 관리하는 PLY origin을 가리킨다. 다른 충전 게임은 기존 주소를 쓴다.
