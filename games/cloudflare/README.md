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
