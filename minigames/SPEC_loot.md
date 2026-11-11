# Z-RIDE 로드 루팅 (공통 아이템 시스템) — 구현 지시서 (Codex용)

기존 코드 전체(허브, shared/, games/*, server/quiz-server.mjs, SPEC_*.md)를 먼저 읽고 이어서 만든다.
- 브라우저: 순수 ES modules, 외부 라이브러리 없음. 서버: Node 26 내장 모듈만(**node:sqlite 사용 가능**), npm 의존성 없음.
- 흑백 손그림 스타일, 한국어 UI, 세로 폰 레이아웃.
- **인코딩: UTF-8(BOM 없음). PowerShell Set-Content/Out-File 금지. 이모지 금지.**
- 기존 게임 3개(폴짝 전봇대, 빗방울 캐치, 실시간 운전면허시험)를 깨지 말 것.

## 0. 이 저장소에 맞춘 범위 조정
- 기획안의 "기존 z-ride 서버/SQLite"는 이 폴더에 없음 → **server/ 의 Node 서버를 확장**해서 구현(quiz-server.mjs를 server/index.mjs로 정리하거나 모듈로 분리, 실행은 `node server/index.mjs` 하나로). 저장은 node:sqlite 파일 server/data/zride.db.
- "차량 화면(관제실)"·"정차 습격 게임"은 이 저장소에 없음 → 차량 화면은 **웹 페이지 `vehicle/garage.html`로 시뮬레이션**(실제 Pleos 앱이 나중에 같은 API를 쓰면 됨). 습격 게임은 없으므로 `GET /party/:id/stats` 로 장비 합산 능력치(방어·탐지·탈출)를 제공하고 garage 화면에 표시까지만.
- 시·도 경계: **실제 행정구역 GeoJSON은 아직 없음.** `data/regions/regions.geojson` 을 읽는 로더를 만들고, 지금은 서울·인천·경기·강원 4곳의 **대략적인 단순 다각형(꼭짓점 10~20개, 명확히 "approximate placeholder" 표시)** 을 넣는다. 판정 순서는 서울·인천을 경기보다 먼저(포함 관계). 나중에 공공데이터 GeoJSON으로 파일만 교체하면 되게. README에 출처 표기 자리 마련.
- 충전소 156곳 데이터도 없음 → `data/points.json` 에 휴게소·충전소·랜드마크 예시 지점 10~15개(이름은 일반명: "서울 충전소 A" 등, 실존 기업명 금지) + 같은 형식으로 교체 가능하게.

## 1. 데이터
### data/items.json (40개)
무기 8 (근접·원거리·설치형 섞어서), 부품 10 (배터리 셀, 케이블, 회로 기판, 냉각수 셀, 연료 등), 차량 장비 12 (슬롯 6개 × 2: bumper / armor / tires / lights / roof / paint), 소모품 6 (의료 키트, 탄약 상자, 연막, 수리 키트 등), 기념품 4 (지역 배지·엽서).
필드: id, name, category(weapon|part|gear|consumable|souvenir), slot(gear만), rarity(common|uncommon|rare|regional|legendary — MVP에선 legendary 미사용), region(seoul|incheon|gyeonggi|gangwon|null), roadType(null — MVP 미사용), conditions([] 또는 ['rain','night']), stats{defense,detection,escape,attack}, description, icon(SVG 키).
- 기획안의 지역 한정 예시(네온 방패, 지하철 레일 블레이드, 항만 크레인 훅, 공항 레이더, 물류 컨테이너 장갑, 스노체인 타이어, 산악 탐조등)를 포함. 이름은 오리지널, 실존 기업·브랜드·차종 이름 금지, 지역 비하 금지(지형·산업·자연 특징만).
- 기존 shared/inventory.js의 item id(part, turret, supply, coolant, ammo, medkit)는 items.json에 매핑(alias)해서 기존 게임 보상이 계속 동작하게.
### data/loot_tables.json
- 지역 4곳 + common: [{itemId, weight}]. 조건 보정: rain, night 일 때 해당 조건 아이템 가중치 ×3.
- 미니게임별 보정: pole-jump → 부품 가중치 ×3, raindrop → 냉각수 셀·소모품 ×3, license-quiz → 정답 분야별 고정 보상 + 지역 아이템 1개 확률 25%.
### 아이콘: shared/item-icons.js — 아이템 아이콘 SVG를 흑백 라인으로 직접 그림(카테고리별 기본 모양 + 몇몇 특수). 등급은 테두리 모양으로 구분(일반 얇은 선, 고급 두 줄, 희귀 점선 이중, 지역 한정 톱니 테두리) — 흑백 스타일 유지.

## 2. 서버 (server/)
- 모듈: loot.mjs(판정 순수 로직, 테스트 가능), regions.mjs(점-다각형 판정), db.mjs(node:sqlite), index.mjs(HTTP+정적+WS, 기존 quiz 기능 포함).
- 테이블: parties, inventory(party_id,item_id,qty), loot_log(party_id,item_id,at,lat2,lng2,region,source), equipment(party_id,slot,item_id), party_state(party_id, region, km_in_region, last_lat, last_lng, last_at, gear, boxes_this_hour, hour_start, pending_boxes).
- 좌표는 **소수점 2자리로 낮춰서** 저장(개인정보). 정밀 좌표는 메모리에서만 판정에 쓰고 저장 안 함.
- API:
  - `POST /loot/tick` {partyId, lat, lng, odometerKm?, speedKmh?, speedLimitKmh?, wiper?, gear?, at} → {region, events:[{type:'region_enter'|'distance_box'|'point_box', items:[...]}]}
    - 시·도 경계를 처음 넘을 때 상자 1개, 그 지역 안에서 10km마다 1개. 거리는 odometer 증가분, 없으면 좌표 누적.
    - 지점 반경 300m 처음 통과 시 지점 상자.
    - 조건: wiper.on → rain, 현지 19~06시 → night.
    - **안전 규칙**: speedLimit 있고 speed > limit 이면 상자 판정을 pending으로 보류, 정상 복귀 후 지급. 제한속도 없으면 규칙 끔. **시간당 상자 최대 12개.** 속도는 보상에 영향 없음.
    - **치트 방지**: 직전 보고 대비 이동 속도 > 250km/h 이거나 순간이동(>5km/10초)이면 그 tick 무시하고 위치만 갱신하지 않음.
  - `POST /loot/minigame` {partyId, gameId, result:{score, correctByType?...}} → 지역 테이블 기반 보상 items. 현재 지역은 party_state 기준(없으면 common).
  - `GET /party/:id/inventory`, `GET /party/:id/loot-log?since=`, `GET /party/:id/codex`(도감: 지역 한정 아이템 수집 여부, 통과한 지역 수, 등급별 수), `GET /party/:id/stats`(장착 장비 합산 능력치).
  - `POST /party/:id/equip` {slot, itemId} — **party_state.gear === 'P' 일 때만 허용**, 아니면 409. gear는 /loot/tick 또는 `POST /party/:id/gear` {gear} 로 갱신(차량 앱이 AAOS GEAR_SELECTION 보고).
- 서버 실행 시 콘솔에 주소 출력. 기존 /api/trigger, /vehicle WS, /api/records, /api/party/inventory 유지(마지막 것은 새 inventory 테이블로 연결).

## 3. 폰 (웹앱)
- shared/loot-client.js: config.SERVER_URL 있으면 서버 API 사용. **없으면 브라우저 안에서 같은 loot.mjs 로직(공용 모듈로 만들기)과 localStorage로 오프라인 동작** — 폰 GPS만으로도 지역 통과 수집이 돌아가야 함.
- 위치 보고: 허브가 열려 있는 동안 + 게임 중에 GPS로 15초마다 tick(또는 100m 이동마다).
- 획득 알림: 화면 위 작은 토스트(아이콘+이름+등급), 진동 1회, 소리 없음.
- **가방 화면** `bag.html`: 분류 탭(무기/부품/장비/소모품/기념품), 아이템 카드(아이콘, 이름, 등급 테두리, 수량, 설명, 능력치). 주행 중엔 보기만.
- **도감 화면** `codex.html`: 지역별(서울·인천·경기·강원) 지역 한정 아이템 칸(획득 전엔 실루엣), 완성률, 통과한 지역 수.
- 허브 상단에 현재 지역, 가방, 도감 링크.
- 기존 미니게임 3개 보상을 /loot/minigame(또는 오프라인 동일 로직)으로 연결 — 결과 화면에 "획득 아이템" 표시. 기존 shared/inventory.js addItem 호출은 새 시스템으로 위임(호환 유지).

## 4. 차량 화면 시뮬레이션 `vehicle/garage.html` (정차 중에만)
- 가로 화면(차량 디스플레이 비율 대략 16:6~16:9). 기어가 P가 아니면 "주행 중에는 사용할 수 없어요" 화면만.
- **전리품 정산**: 이번 주행(드라이브 시작 이후) 획득 목록을 시간순으로, 출처(지역 통과/지점/미니게임 이름) 표시.
- **장비 장착**: 2D 와이어프레임 범용 차량(측면 실루엣, 실차 형태·엠블럼 금지)과 슬롯 6개 위치 표시(범퍼 앞, 장갑판 옆, 타이어, 라이트, 루프, 도색=차 전체 패턴). 슬롯 탭 → 보유 장비 목록에서 선택 → 장착. 합산 능력치(방어·탐지·탈출) 막대.
- dev 모드에서 기어 P/D 토글.

## 5. 개발용 가짜 경로 재생
- `dev/route-replay.html`(또는 dev 패널 버튼): 서울 → 인천 → 경기 → 강원 좌표 시퀀스(대략 40~80점, 실제 도로 형태일 필요 없음)를 배속(×10, ×50) 재생, 와이퍼 on/off 구간, 일부 구간 과속(제한속도 초과) 포함 → /loot/tick 호출(오프라인 모드면 로컬 로직). 화면에 현재 지역, 누적 km, 상자 이벤트 로그.
- `scripts/test-loot.mjs`: 같은 경로를 Node에서 재생해 PASS/FAIL 검사 — 지역 진입 상자 4회, 10km 상자, 시간당 12개 상한, 과속 중 보류 후 지급, 치트 순간이동 무시, 좌표 소수점 2자리 저장, gear≠P 장착 409.

## 6. 기록·리더보드 준비
- records에 loot 요약 저장: 통과 시·도 수, 총 획득 수, 등급별 수, 지역 한정 수집 수(도감 완성률). 리더보드 UI는 만들지 않음.

## 완료 조건
- 모든 js node --check 통과, scripts/test-quiz-engine.mjs와 scripts/test-loot.mjs 모두 PASS.
- `node server/index.mjs` 로 웹앱 전체가 열리고 API 동작.
- README 갱신(실행법, API, 데이터 교체 방법, 출처 표기 자리).
- 바뀐/새 파일 목록 출력.
