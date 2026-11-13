# PLY

외부 패키지 없이 실행하는 한국어 미니게임 및 운전 전리품 웹앱입니다. 게임 화면은 흑백 손그림 스타일을 사용하며, 메뉴와 주요 버튼에는 PLY 공통 스타일을 적용합니다. 데스크톱과 세로형 모바일 화면을 지원합니다.

## 실행

권장: 프로젝트 루트에서 Node 서버를 실행합니다. 정적 웹앱, 기존 운전면허 퀴즈 WebSocket, Loot API와 SQLite 저장소가 함께 시작됩니다.

```sh
node server/index.mjs
```

기본 주소는 `http://localhost:8787`입니다. 포트는 `PORT` 환경 변수로 바꿀 수 있습니다. 서버 없이 정적 파일만 시험하려면 프로젝트 루트에서 `python -m http.server 8080`을 실행합니다. 이 모드에서는 Loot가 브라우저 `localStorage`에 저장됩니다.

검증 명령:

```sh
node scripts/test-quiz-engine.mjs
node scripts/test-loot.mjs
```

## Loot 기능

- 허브와 게임 화면에서 위치 권한을 허용하면 15초 주기로 위치를 보고합니다. 위치 접근을 허용하지 않아도 게임은 계속 사용할 수 있습니다.
- 획득 아이템은 상단 알림과 `bag.html`에서 확인합니다. 지역 한정 수집은 `codex.html`, 차고 시뮬레이션은 정차 상태의 `vehicle/garage.html?dev=1`, 경로 테스트는 `dev/route-replay.html`에서 확인할 수 있습니다.
- 안전 보상 규칙은 제한속도 초과 중 보상을 대기시키고, 시간당 보상을 12개로 제한합니다. 순간이동 또는 250km/h 초과 이동은 해당 위치 tick을 무시합니다.
- 서버 API: `POST /loot/tick`, `POST /loot/minigame`, `GET /party/:id/inventory`, `GET /party/:id/loot-log?since=`, `GET /party/:id/codex`, `GET /party/:id/stats`, `POST /party/:id/equip`, `POST /party/:id/gear`.
- 서버 데이터는 `server/data/zride.db`의 `node:sqlite` 데이터베이스에 저장합니다. 정밀 좌표는 판정 후 버리고 DB에는 위도와 경도를 소수점 둘째 자리까지만 저장합니다.

## 데이터 교체

아이템 아이콘은 `shared/assets/items/<id>.svg`에서 공용으로 사용할 수 있습니다. 다른 게임은 아이템 ID에 해당하는 SVG를 `<img src="../../shared/assets/items/battery-cell.svg" alt="배터리 셀">`처럼 불러오면 됩니다. 아이콘 색은 `--ply-common` 또는 `--ply-specialized` 토큰을 따릅니다.

- `data/items.json`: 40개 아이템의 고유 ID, 이름, 분류, 등급, 지역, 조건, 능력치, 설명, 아이콘 키를 정의합니다. `scope`는 가방과 획득 알림에서 표시하는 사용 범위입니다.
  - `common` 9종은 기본 보급 재료입니다. 배터리 셀, 정비 부품, 보급품 등이 해당합니다.
  - `specialized` 31종은 DEADZONE 효과가 있거나 특정 지역에서 수집하는 아이템입니다. 네온 방패, 수리 키트, 지역 기념 배지 등이 해당합니다.
  - `rarity`는 아이템 등급입니다. 기존 게임 보상 ID(`part`, `turret`, `supply`, `coolant`, `ammo`, `medkit`)도 유지합니다.
- 여행 지도에 표시하는 파티 보급품은 파티 서버 재고입니다. 가방에는 기기에서 획득한 미니게임 아이템이 표시됩니다.
- `data/loot_tables.json`: 지역별 및 공통 상자 가중치를 정의합니다. 비·야간 조건과 미니게임에 따른 추가 가중치는 `shared/loot-engine.js`에서 적용됩니다.
- `data/regions/regions.geojson`: 서울·인천·경기·강원의 단순 다각형입니다. 각 경계는 `approximate placeholder`이며 실제 행정구역 경계가 아닙니다. 정확한 공식 GeoJSON을 확보한 뒤 이 파일을 같은 FeatureCollection 형식으로 교체하고 출처를 아래에 기록하세요. 현재 공식 경계 데이터 출처는 아직 선정하지 않았습니다.
- `data/points.json`: 일반명으로 만든 충전소, 휴게 지점, 랜드마크 예시 12개입니다. 실제 서비스 지점 자료로 교체할 수 있습니다. 현재 공식 지점 데이터 출처는 아직 선정하지 않았습니다.

## 유지보수 참고

다음 후보: 전봇대 사이 줄타기 이동을 추가합니다. 동승자 여러 명이 한 화면에서 함께 뛰는 방식을 검토합니다.

브라우저는 순수 ES modules를 사용하며 npm 패키지가 없습니다. `shared/loot-engine.js`는 서버와 오프라인 클라이언트에서 공통으로 사용하는 결정 로직입니다. `server/index.mjs`가 정적 파일, Loot API, 기존 퀴즈 API 및 `/vehicle` WebSocket을 함께 제공합니다.

## 통합 여정에서 실행

Pleos의 Z-RIDE 파티를 시작하고 QR로 동승자를 승인한다. 정차 중 Pleos의 **주행 중 동승자 게임**에서 게임을 추천할 수 있다. D에서는 Pleos가 게임 앱을 가리며, 폰의 **여행 지도**에서 동승자가 직접 게임을 선택한다. 기어가 D를 벗어나거나 차량 속도 보고가 만료되면 폰은 지도로 돌아간다.

통합 실행은 파티 스냅샷의 차량 속도와 순정 내비에서 받은 제한속도·좌우회전 안내를 사용한다. 폰의 GPS나 별도 개발 서버는 필요하지 않다. 빗방울 캐치의 빗방울과 터널은 게임 연출이며 실제 강수·터널 센서는 연결되어 있지 않다. 미니게임의 개인 기록과 아이템은 기존과 같이 브라우저에 저장한다.

개발은 리포지터리의 `minigames/` 자산을 사용한다. 서버 컨테이너나 릴리스 번들은 같은 자산을 `drive-assets/`에 넣는다. 자산은 통합 서버의 `/play/drive/`에서 지정된 파일만 제공한다. 기존 배포 도구가 이 자산을 묶지 않는 환경에서는 서버는 계속 실행되며 동승자 게임 메뉴가 숨겨진다. 새 릴리스를 적용할 때는 `drive-assets/`를 포함하는 배포 도구 버전을 함께 사용한다.
