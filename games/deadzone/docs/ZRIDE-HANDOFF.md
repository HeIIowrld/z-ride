# Z-RIDE DEADZONE — 웹앱·차량 대시보드 인계

2026-11-11. OVERRUN 기반의 독립 프로토타입. 원본 Apache-2.0 LICENSE와 NOTICE를 유지한다.

## 실행과 화면

- 소스 루트: 이 문서의 상위 디렉터리.
- Node.js 22.12 이상, `npm ci`, `npm run build`.
- `cd packages/server && WRANGLER_SEND_METRICS=false ../../node_modules/.bin/wrangler dev --local --ip 0.0.0.0 --port 8788 --config wrangler.local.toml`
- 폰 웹앱: `/`. 1~4명 선택 → 협동 방 만들기 → QR/링크로 참가 → 전원 준비 완료 → 5초 카운트다운.
- 동시 미리보기: `/preview.html`. 844×390 폰 iframe과 1280×720 차량 iframe을 나란히 표시한다. 방 생성·AI 체험을 오른쪽 관전 화면에 자동 연결한다.
- 차량 화면: `/dashboard`. 차량이 먼저 팀을 만들면 플레이어 자리를 차지하지 않고 QR을 표시한다.
- 혼자 체험: 선택 인원 - 1명을 AI 동료로 채운다. 실제 다중 폰 참가와 구분한다. 게임 HUD의 차량 대시보드 링크는 `/dashboard?practice=1`로 현재 체험의 실제 상태를 BroadcastChannel로 전달한다. 같은 브라우저·같은 origin에서만 동작한다.
- 서버 경기 대시보드는 1초마다 read-only HTTP 상태를 받는다. 별도 폰에서도 동일 방을 관전할 수 있다.
- 같은 Wi-Fi 폰에서 Mac의 LAN 주소 `http://<Mac IP>:8788`로 연다. localhost QR은 폰에서 Mac을 가리키지 않는다. Pleos AVD의 Mac 호스트 주소는 `http://10.0.2.2:8788`이다.
- LAN HTTP는 개발용. HTTPS·WSS 도메인과 실제 폰 네트워크 검증은 팀 배포 단계에서 준비한다.

## 게임 규칙

| 선택 인원 | 좀비 생성 예산 배율 |
|---|---|
| 1 | 1.00 |
| 2 | 1.72 |
| 3 | 2.44 |
| 4 | 3.16 |

방 생성 시 정원과 난이도를 고정한다. 전원이 참가하고 준비해야 시작한다. 연결 끊김으로 난이도를 낮출 수 없다.
좀비 HP는 기존 웨이브 증가 규칙을 유지하고 인원별로 불필요하게 배가하지 않는다.
기본 적을 직접 작성한 저폴리 좀비 모델로 바꾸고, 기존 AI의 추적·근접·원거리·변이·보스 패턴을 유지했다.
DEADZONE 협동 방과 로컬 AI 체험의 목표는 주차장 중앙의 팀 차량을 세 웨이브 동안 방어하는 것이다.
일부 근접 좀비가 차를 공격하며, 차량 내구도가 0이면 작전에 실패한다.
청록색 퓨즈를 한 번에 하나씩 차 뒤 노란 구역으로 가져오면 팀 보관함에 자동으로 들어간다.
트렁크 근처에서 퓨즈 1개로 내구도 40을 회복하거나, 게임 속 헤드라이트를 3초간 켜서 전방 좀비를 멈출 수 있다.
폰은 버튼, 키보드는 R/T를 사용한다. 이 효과는 게임 시뮬레이션 안에서만 발생한다.
게임 안 보급품·회복·점수와 웨이브 업그레이드는 원본 시뮬레이션을 사용한다.
기존 Z-RIDE 이동 중 지도 수집/영속 재고 API는 아직 연결하지 않았다.

## 서버 접점

### 팀 생성

`POST /api/zride/rooms`, JSON `{ "players": 4, "hostName": "팀장" }`.
정수 1~4만 허용. 201 응답:

```json
{
  "code": "ABC234", "mode": "coop", "players": 4,
  "joinPath": "/j/ABC234",
  "dashboardPath": "/dashboard#ABC234.<dashboard-token>",
  "dashboardToken": "<opaque-token>"
}
```

QR에는 joinPath만 넣는다. dashboardToken은 관전자 권한이고 QR이나 폰 초대에 포함하지 않는다.
대시보드 URL의 fragment는 HTTP 요청에 전송되지 않는다. 상태 조회 때만 `x-dashboard-token` 헤더로 보낸다.

### 차량 대시보드 데이터

`GET /api/zride/rooms/{code}/status`, header `x-dashboard-token: <token>`.
키가 없거나 틀리면 403. 응답은 `cache-control: no-store`.
계약의 기준은 `packages/shared/src/zride.js`의 `dashboardSnapshot`이다.

- `schema`: `zride.dashboard.v1`
- `roomCode`, `state`: lobby / countdown / playing / ended
- `targetPlayers`, `connectedPlayers`, `difficulty.spawnMultiplier`
- `wave`, `phase`, `elapsed`(초), `teamScore`, `kills`, `timestamp`(서버 Unix ms)
- `players[]`: id, name, ready, connected, hp/maxHp/shield, down, alive, kills, score, x/z. 경기 전 HP는 null이다.
- `enemies[]`: 게임 평면의 x/z, kind. 실제 위치/GPS가 아니다.
- `pickups[]`: 게임 내부 보급품. Z-RIDE 영속 소지품과 다르다.
- `defense`: 방어전의 게임 상태. `hp`, `maxHp`, `fuses`, `flash`(남은 초), `carriers`(운반 중인 플레이어 ID 배열). 기존 경기나 아직 생성되지 않은 시뮬레이션은 null.
- `outcome`: 종료 사유. 차량 방어 성공은 `vehicle_defended`, 파괴는 `vehicle_destroyed`, 전원 전투 불능은 `wipe`.
- `vehicle`: source=unconnected, parked=null, controlsEnabled=false. 서버가 실제 주차 상태를 추정하지 않는다.

현재 결과·순위는 해당 경기의 실시간 순위다. 과거 전체 순위/계정 보상은 연결하지 않았다.
이 API는 기존 Z-RIDE HTTP/WS 계약을 변경하지 않는다. 기존 서버에 합칠 때 세션 ID/참가 승인/영속 재고를 연결하는 어댑터를 넣고, 이 시뮬레이션의 상태 작성자는 하나만 유지한다.

## Pleos 팀 작업 범위

`integrations/pleos/DeadzoneDashboardView.java`는 기존 앱에 아직 설치하지 않은 WebView 참조 구현이다.
Android 표준 API만 사용한다. 앱 팀이 정한 HTTPS origin의 dashboard URL만 열고,
`setDisplayAllowed(실제 P 조건 && UX 제한 통과)`를 실제 차량 SDK 콜백에서 호출한다. 기본값은 표시 차단이다.
이 컴포넌트는 공조·조명·벨트·문·좌석 등을 조작하지 않는다.

대시보드는 `window.ZRideDashboardBridge.onSnapshot(JSON문자열)`이 있으면 같은 계약을 네이티브로 전달한다.
네이티브 Compose/Canvas로 다시 그릴 때도 위 상태 계약을 그대로 사용하면 된다.
초기 인계 뒤 별도 `dashboard-preview` 앱을 추가하여 Pleos AVD에 설치·실행했다. 실제 Pleos WebView 131에서 4명 TEST 참가자 방의 실시간 상태를 읽고 Java bridge 수신을 확인했다. 실물 폰·실차·Vehicle SDK 연동 검증은 아니다. 네이티브 앱 표시 영역에서 하단 카드가 잘리지 않도록 WebView 전용 크기 보정을 적용했다.

## 주요 파일

- 웹 흐름: `packages/client/src/main.js`, `packages/client/index.html`
- 웹 디자인: `packages/client/src/ui/zride.css`
- 좀비 외형: `packages/client/src/render/swarm.js`
- 주차장: `packages/client/src/render/arena.js`
- 대시보드: `packages/client/dashboard.html`, `packages/client/src/dashboard/`
- 방 정원·관전: `packages/server/src/index.js`, `MatchRoom.js`, `Matchmaker.js`
- 인원별 정책·대시보드 계약: `packages/shared/src/zride.js`, `sim.js`, `director.js`

## 검증

- `node tools/test-vehicle-defense.mjs`: 퓨즈 운반·재접속 전 드롭·수리·헤드라이트·3웨이브·상태 직렬화.
- `node tools/test-zride.mjs`: 인원 유효성, 1~4인 난이도, 연결 끊김 후 고정 배율, 대시보드 계약.
- 서버 실행 후 `BASE=http://127.0.0.1:8788 node tools/test-zride-live.mjs`: 실제 HTTP/WS 1~4인 참가, 정원 초과 거부, 전원 준비 조건, 웨이브 시작, 관전자 키.
- `node tools/simtest.mjs`: 기존 시뮬레이션과 입력/스냅샷 프로토콜 회귀 검증.
- `node tools/physics.mjs`: 이동·넉백 11개 회귀 검증.
- `npm run build`: 게임과 대시보드 production bundle.

브라우저·서버 시험과 실물 폰/실차 시험은 구분한다. 브라우저 viewport 검사는 물리 터치 성능 검증이 아니다.

추가 검증: 실행 중인 1인 방의 동일 토큰 재접속에서 플레이어 ID 유지가 통과했다. WebView 참조 구현은 Android API 34 android.jar로 Java 17 컴파일을 통과했다. APK/차량 실행 결과는 아니다.

## 좀비 외형 보강 및 Pleos 확인

`/infected.html`에서 게임에 쓰는 실제 네 종류의 3D 모델·GPU 보행을 볼 수 있다. 게임의 좀비와 같은 렌더 모듈을 사용한다.
에뮬레이터 확인용 소스는 `integrations/pleos/dashboard-preview/`에 있다. 빌드 방법은 게임 디렉터리의 README를 참고한다.
