# Z-RIDE 동승자 게임 — 구현 지시서 (Codex용)

이 폴더(zride-games/)에 빌드 도구 없이 동작하는 웹앱을 만든다. 순수 HTML + ES modules + Canvas 2D. 외부 라이브러리·npm 금지. `python -m http.server 8080`로 이 폴더를 서빙하면 바로 실행돼야 한다. 폰 세로/가로 모두 대응하되 게임은 가로 권장 안내. UI 문구는 한국어.

## 1. 폴더 구조
```
index.html              게임 허브(게임 목록 카드, 좌석 선택, 인벤토리 보기)
shared/
  vehicle.js            속도·제한속도 소스
  seat.js               좌석 선택(left/right 창) 저장·조회
  inventory.js          파티 공동 인벤토리
  records.js            플레이 기록 저장(리더보드 준비)
  config.js             SERVER_URL 등 설정 (기본 null = 오프라인)
games/pole-jump/
  index.html
  game.js               게임 로직·렌더
README.md               실행법, 공통 모듈 API, 기록 스키마, 새 게임 추가 방법
```
모든 localStorage 접근은 try/catch.

## 2. 공통 모듈
### vehicle.js
`createVehicleFeed({dev})` → EventTarget 비슷한 객체, `on('update', cb)`, `stop()`.
update payload: `{ speedKmh, speedLimitKmh|null, distanceDeltaM, source }`.
- 기본: `navigator.geolocation.watchPosition` (enableHighAccuracy). `coords.speed`(m/s) 사용, null이면 두 점 거리/시간으로 계산. 지수 평활(alpha 0.3)로 보간. 이동 거리는 haversine 누적, 정확도 50m 넘는 점은 무시.
- 제한속도: config.SERVER_URL이 있으면 WebSocket `${SERVER_URL}/vehicle` 에서 `{type:'speedLimit', kmh}` 와 `{type:'speed', kmh}`(오면 GPS 대신 차량 속도 사용) 수신. 없으면 null.
- dev 모드(URL `?dev=1`): GPS 대신 화면 우측 상단 작은 패널의 슬라이더(속도 0~150, 제한속도 0~120, '제한속도 없음' 체크박스)로 값 생성, 거리는 속도×시간으로 적분.

### seat.js
`getSeat()` → 'left'|'right'|null, `setSeat(v)`. 허브와 게임 첫 실행 시 null이면 선택 모달(조수석/뒷좌석 우 = right, 뒷좌석 좌 = left).

### inventory.js
`addItem(id, qty, meta)`, `getInventory()`, `onChange(cb)`. 아이템 정의 테이블 `ITEMS = { part: {name:'부품', type:'material'}, turret: {name:'터렛', type:'equipment'}, supply:{name:'보급품', type:'material'} }`. 저장은 localStorage 'zride.inventory'. SERVER_URL 있으면 `POST /api/party/inventory` 로 delta도 보냄(실패해도 무시, 큐에 쌓아 재시도).

### records.js
`saveRecord(rec)`, `getBest(gameId)`, `getRecords(gameId)`.
스키마:
```
{ id(uuid), gameId, playerId(로컬 uuid), partyId|null, score, durationMs, distanceM,
  stats:{...게임별}, endReason, createdAt(ISO), clientVersion }
```
localStorage 'zride.records'. SERVER_URL 있으면 `POST /api/records`(실패 시 큐). 리더보드 UI는 만들지 않음 — 허브에 "내 최고 기록"만 표시.

## 3. 게임: 폴짝 전봇대 (games/pole-jump, gameId 'pole-jump')
### 화면
- 가로 2D. 화면 가장자리에 둥근 차창 틀 테두리. 바깥: 하늘 그라데이션, 먼 산(느린 패럴랙스), 논밭(중간), 전봇대(가장 앞).
- 스크롤 방향: seat='right' → 풍경이 왼쪽→오른쪽으로 흐름, 'left' → 오른쪽→왼쪽. (코드에서 dir=+1/-1 하나로 처리)
- 전봇대: 세로 기둥, 위쪽 가로 완목·애자, 기둥 사이 전선(늘어진 곡선). 각 기둥에 높이 라인 3개(1 위, 2 중간, 3 아래) 발판 표시.
- 캐릭터: 오리지널 "손가락 닌자"(손가락 모양 몸통 + 머리띠, 단순 도형). 현재 기둥의 현재 높이 라인에 붙어 기둥과 함께 흘러감. 점프는 다음 기둥으로 포물선 애니메이션 ~250ms.
- 상단 HUD: 점수, 콤보, 표지판 아이콘 "현재 xx km/h / 제한 [yy]"(제한속도 null이면 "제한속도 정보 없음"), 부품 획득 수.
- 정지 중(속도<3km/h 1초 이상): 화면 흐리게 + "정차 중 — 일시정지", 입력 무시.

### 월드·스크롤
- 픽셀/미터 스케일 고정 PX_PER_M (예: 화면 폭 = 약 120m). 스크롤 속도 = speedKmh/3.6 × PX_PER_M.
- 기둥 간격: 기본 50m(실제 이동 거리 50m마다 1개). 31개 이후 40~65m 랜덤.
- 단, 차 속도는 vehicle feed의 distanceDelta 누적이 아니라 화면 스크롤을 speed로 적분해 일관성 유지(거리 기록은 feed 거리 사용).

### 조작
- 탭(또는 스페이스) = 다음 기둥으로 점프. 판정은 점프 시점의 다음 기둥까지 화면상 거리 d:
  - d ≤ JUMP_REACH → 성공. |d - IDEAL| ≤ PERFECT_WIN → 퍼펙트.
  - d > JUMP_REACH (다음 기둥이 아직 멀다) → 빈 공간 낙하, 게임오버 'fall'.
- 현재 기둥이 화면 뒤쪽 가장자리를 벗어나면 게임오버 'pushed_out'.
- 위/아래 스와이프(또는 방향키) = 현재 기둥에서 높이 라인 이동 1↔2↔3.
- 착지한 높이에 장애물 있으면 게임오버 'obstacle'.
- 처음 10개는 JUMP_REACH 넉넉하게(1.3배), PERFECT_WIN도 넉넉하게.

### 장애물
- 1~10개: 없음. 11~30: 기둥마다 3칸 중 1칸(애자/변압기/까치집/전단지 중 랜덤). 31~: 최대 2칸 + 확률 20%로 전선 위 새(기둥 사이를 위아래로 움직이며 점프 경로의 해당 높이를 지나면 충돌).
- 항상 최소 1칸은 비어 있어야 함.

### 점수
- 착지 10점, 퍼펙트 +5 × 콤보배수(연속 퍼펙트 n → 배수 min(n,5)). 퍼펙트 아니면 콤보 리셋.
- 속도는 점수에 영향 없음.
- 착지 10개마다 inventory.addItem('part',1,{from:'pole-jump'}) + 작은 "+1 부품" 팝업.

### 과속
- speedLimit != null && speed > limit → 빨간 테두리 깜빡임, 경고음(WebAudio 짧은 비프), "과속!" 표시.
- 연속 2초 이상 → 감전 연출(캐릭터 지그재그 번개, 화면 플래시) 후 게임오버 'speeding'.
- 제한속도 null이면 과속 판정 끔.

### 게임오버·결과
- endReason: fall | pushed_out | obstacle | speeding. 결과 화면: 점수, 옮긴 기둥 수, 최대 콤보, 퍼펙트 수, 시간, 획득 부품, 이유 문구, 최고 기록 여부, 다시하기/허브로.
- records.saveRecord({gameId:'pole-jump', score, durationMs, distanceM, stats:{poles, perfects, maxCombo, parts}, endReason, ...}).
- 최고 기록 갱신 시 스킨 해금 플래그 localStorage 'zride.skins'에 'ninja_gold' 추가(결과 화면에 표시만).

### 기타
- 소리는 WebAudio로 합성(외부 파일 없음). 음소거 버튼.
- requestAnimationFrame, devicePixelRatio 대응, 화면 크기 변경 대응.
- 주석에 Pleos 연동 지점 표시: 차량 앱이 NaviHelper onCurrentRoadSpeedLimit()/onDrivingInfo() 값을 서버로 보내고 서버가 /vehicle WS로 폰에 전달.
- 데스크톱 테스트: `games/pole-jump/index.html?dev=1` 에서 슬라이더 + 키보드로 전부 플레이 가능해야 함.

## 4. 완료 조건
- 콘솔 에러 없음. dev 모드에서 시작→점프→장애물→과속 게임오버→결과 저장→허브에 최고 기록 표시까지 동작.
- README.md 작성.
