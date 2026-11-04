# Z-RIDE 최소 방 서버

통합 통신 목업: **https://hyundai.hjpark.net/play/demo** — 센터페시아 QR·수동 승인과 폰 로그인/참가를 나란히 확인한다. [실행·API 순서](docs/vehicle-phone-mock.md). 실제 차량 SDK 대신 시뮬레이션 신호를 사용한다.

폰 참가: **https://hyundai.hjpark.net/play** · [Google/게스트 로그인·QR 참가](docs/phone-accounts.md#폰-웹-참가-페이지--2026-11-04). 클라이언트 ID는 운영 `GAME_GOOGLE_CLIENT_ID` 설정, 폰은 서버에서 공개 설정을 조회한다. 실제 Google 동의는 사용자 브라우저에서 수행한다.

revision 10: [폰 계정·QR 참가·차량 전환 API와 목업](docs/phone-accounts.md). Google 설정 전 비활성, REST 55개.

revision 9: [범용 미션·이벤트 회차·결과·보상·재생성](docs/events-results-rewards.md).

revision 8: [파티 공동 수집·5분 리스폰](docs/collection-respawn.md) · [도메인 연결 인계](docs/domain-handoff.md) · [부하 검증](docs/load-validation-20261102.md).

revision 7: 원본 장소 import·검수/접근성·경로 corridor·QR 게스트·탈퇴/제거/해산·스팟별 파티 공개/공동 기여를 추가했다. REST 36개. [장소·파티 계약](docs/places-parties.md). Google/Pleos 로그인은 비활성 연동 포트로 남긴다.

revision 6: 서버가 시나리오·임무 단계·역할·목표 기여·가상 이동과 공조·벨트·에너지 관측 상태를 관리한다. 조회 2개와 게임 POST 4개를 추가해 전체 REST는 21개다. 앱 팀은 입력·센서 관측을 보내고 서버 snapshot을 화면에 반영한다. [서버 상태 계약·시연 방법](docs/server-state.md)

4D 효과는 방별 `/effects` 조회와 `session / scene / cue / stop` POST, 현재 CAR_HOST WebSocket의 `vehicle.effect.report`로 처리한다. heist 임무의 장면·속도는 서버 게임 상태에서 연결한다. 실제 SDK 실행은 차량 앱이 로컬 조건을 확인해 수행하며, 현재 참조 Android 앱에는 이 native 실행기가 없다. [4D 차량 효과 API](docs/vehicle-effects.md)

현재 CLI 서버는 SQLite에 방·세션 해시·승인·재고·진행·중복 지급 기록을 저장한다. 재시작 때 연결/차량 lease를 초기화하고, 진행 중 전투를 PAUSED로 복구한다. 저장 실패는 503으로 차단하며 성공 응답과 방송은 커밋 후에만 전송한다. 테스트용 `createDemoServer()`는 dbPath를 생략하면 메모리 모드다. [영속성](docs/persistence.md)

`/observer`는 운영자 키로 방 목록·4인/개인별 게임 상태를 보는 읽기 전용 제품 화면이다. 실제 기기 픽셀·음성 영상 중계와 구분한다. [관제](docs/observer.md), [Proxmox·CI/CD](docs/deployment.md)

2026-11-01. Pleos 차량 앱과 동승자 폰이 같은 방에 참가하는 HTTP + 표준 WebSocket 서버다. **폰 독립 수집과 주차 공동 전투를 분리**한다. revision 4는 외부 팀 테스트 접근키를 추가한다. `/play`는 아이폰 Safari용 최소 참가 클라이언트이며 좌석별 사격·GPS 없는 데모 수집을 제공한다. 실제 지도·현장 GPS는 이 브라우저 버전에 포함하지 않는다.

## 실행

Node 22.13 이상, 의존성 `ws` 8.22.1(MIT)을 사용한다. `package.json`과 `package-lock.json`으로 버전을 고정했다. 라이브러리 출처: [공식 ws 저장소](https://github.com/websockets/ws).

```powershell
node server.mjs
```

기본 주소는 `127.0.0.1:8000`이다. AVD에서는 `http://10.0.2.2:8000` 및 `ws://10.0.2.2:8000/ws`를 사용한다. 외부 팀 테스트는 `http://afsd.iptime.org:8000`, 관제는 `/observer`, 폰 참가는 `/play`다. 공개 배포의 `ZRIDE_TEST_ACCESS_KEY`는 `/api/session`의 `accessKey`로 보내며 관찰키와 다르다. 실제 값은 별도로 전달한다. HTTP 팀 테스트 주소는 암호화되지 않으며 실제 개인정보를 다루는 정식 서비스에는 HTTPS/WSS가 필요하다.

계약은 [protocol.json](protocol.json)이다. 이전 설계의 17개 HTTP API를 전부 구현한 것이 아니라 별도 이름의 `zride-demo-v1` 수직 데모다.

## 동작

1. 차량/폰은 `/api/session`에서 각각 `CAR_HOST`/`PHONE` 세션을 만든다.
2. 차량은 `/api/rooms`로 방을 만들고 `/ws`에 인증한다.
3. 폰은 차량의 일회성 코드를 `/api/join`에 입력하고 참가할 좌석을 고른다.
4. 차량 화면에서 `/approve`로 참가자를 승인한다. 좌석은 사람이 선택한 매칭이며 신원 자동 판별이 아니다.
5. 차량이 실제 어댑터에서 읽은 `vehicle.report`를 전송한다. UX 또는 P가 미상이면 플레이를 막는다. `foreground=false`인 앱 숨김도 별도 APP_INACTIVE 조건으로 차단하며 플랫폼 UX 값을 거짓으로 바꾸지 않는다. 네이티브 앱은 소켓 연결마다 증가하는 `reportSeq`를 사용하고 서버는 이전 순서 보고를 거부한다. reportSeq가 빠진 구형 클라이언트에는 수신 순서만 확인하는 호환 모드가 남는다.
6. 승인된 폰 동승자는 `passengerConfirmed=true`를 명시하고 `mobile.collect`로 테스트 보급 상자를 수집한다. 이 폰 독립 행동은 차량 전투 PAUSED·주행 제한·앱 숨김·차량 연결 끊김·낡은 battle epoch와 별개로 가능하다. 운전자 역할에는 허용하지 않는다.
7. 차량이 주차 게이트를 확인하고 `round.start`로 공동 전투를 시작/명시 재개한다. 폰은 자신의 좌석 각도 내에서 `fire`, 차량은 수집된 supplies 1을 소모해 `support.pulse`로 5초간 damage 3 지원을 제공한다. 재료가 0이면 SUPPLY_REQUIRED로 거부하며 무료 지원은 없다.
8. 서버는 명중/HP/사격 영역/중복 명령/epoch를 검사하고 양쪽에 동일한 상태를 전파한다. 정적 좀비 3개는 -100°·60°·140°에 있고 HP는 각각 5다. 발사각 15° 이내의 살아 있는 최근접 적만 피해를 받는다. `room.zombies`와 `stats.lastShot`을 관제·폰이 함께 렌더링한다.
9. UX 제한·P 이탈·차량 연결 단절·6초 보고 만료는 **공동 전투를** pause한다. 차량 앱은 서버보다 먼저 로컬 입력·소리·화면을 중단해야 한다. 이 변화가 폰의 독립 수집까지 자동 정지시키지는 않는다.

차량 상대 각도는 0° 전방, +90° 오른쪽, -90° 왼쪽, ±180° 뒤다. 운전자는 사격하지 않고 시작·승인·지원을 맡는다. 앞 동승석은 -45..90°, 뒷좌석 왼쪽은 -180..-45°, 오른쪽은 45..180°다. 경계 포함·겹침 허용이며 같은 후방인 -180°와 +180°는 양쪽 뒷좌석에서 허용한다. 실제 사격·충돌·시야를 재현하는 수치가 아니라 게임 규칙이다. 세 적이 모두 죽으면 `CLEARED`가 되고, 차량의 명시적인 다음 `round.start`에서 새 웨이브를 시작한다. 플레이 중 좌석 재배정은 거부하며 pause 후 호스트가 다시 승인해야 한다.

처음부터 착석 센서가 UNKNOWN이면 수동 승인 상태를 `MANUAL_UNKNOWN`으로 표시하고 데모 사격을 허용한다. 실제 `EMPTY` 보고를 받으면 그 좌석의 사격을 막고, 뒤의 UNKNOWN·누락 보고로 자동 해제하지 않는다. 새 OCCUPIED 또는 현재 UNKNOWN에서 호스트의 `allowManualUnknown=true` 명시 재승인으로만 해제한다. 이 잠금에는 마지막 EMPTY 관측도 포함되므로 현재 착석값의 독립 인증이라고 보지 않는다. UX·기어 미상은 공동 전투 잠금으로 처리한다. 충전 상태는 표시만 하며, 이 서버는 충전 연동 모드의 구현 완료를 주장하지 않는다.

위 UX·P·착석 조건은 차량과 폰의 **공동 전투** 조건이다. `mobile.collect`에는 승인된 폰 역할과 동승자 자가 확인만 사용한다. 움직이는 동안 차량 앱이 숨겨지면 차량 상태·착석 근거가 낡을 수 있으므로 이를 폰 수집의 실시간 탑승자 증명으로 쓰지 않는다. 실제 운전자 판별·주행 중 폰 안전 검증이 완성된 것이 아니다.

## 테스트 수집의 범위

`DEMO_PICKUP_A/B/C`는 좌표가 없는 고정 테스트 fixture다. 화면과 snapshot에 **테스트 수집 지점 · GPS 미검증**, `mode=DEMO_PICKUP`, `gpsVerified=false`를 표시한다. 이 버튼 수집 경로는 위치 도달·GPS 정확도·측정 나이를 검사하지 않는다. 폰 위치 입력·거리·품질 조건을 검사하는 별도의 revision 3 world API는 아래 절과 [ADR-003](docs/ADR-003-phone-world.md)에 구분했다. 하드웨어 위치 인증·실제 현장 방문을 보장하는 API는 아니며, 주행 중 차량 GPS/VHAL 중계도 추가하지 않았다.

각 승인 동승자는 같은 방에서 각 fixture를 한 번만 수집할 수 있다. commandId 재전송은 같은 결과를 돌려주고, 새 commandId로 같은 pickup을 반복해도 ALREADY_COLLECTED로 거부한다. 수집 시 공동 `room.collection.inventory.supplies`가 1 증가하고 본인 `collectedPickupIds`가 갱신된다. 차량에는 공동 재고만 보이고 다른 폰의 개별 수집 목록은 보여주지 않는다.

이 좌표 없는 fixture 보급은 실제 위치 기반 보상으로 홍보하지 않는다. 운영 버전에서는 revision 3의 제한적인 위치 입력 검사에 더해 위치 진실성·계정 신뢰·영속 판정, 데이터 고지·보존·권한 정책을 보강해야 한다.

## 폰 지도 world API — revision 3

승인된 PHONE 동승자 전용 `POST /api/world/nearby`, `/location`, `/claim`을 추가했다. nearby는 WGS84 중심·반경으로 서울 시청 주변 테스트 게임 지점 세 개를 제공한다. 실제 충전소나 검수된 주차 지점은 아니다. 지도 타일은 폰이 직접 받으며 서버는 중계하지 않는다.

claim은 폰이 보고한 위치의 80m 반경·정확도 50m 이하·측정 나이 10초 이하, 현재 scheduleId·version, 같은 멤버/스폰/일정의 1회 지급을 검사한다. `locationValidated`는 이 입력 검사 통과를 뜻하고 `hardwareAttested=false`다. 에뮬레이터 위치 소스는 isMock=false여도 MOCK_DEMO로 표시한다. 위치 없는 기존 DEMO_PICKUP 버튼과 별도다.

원시 폰 좌표는 저장하거나 다른 기기에 전파하지 않는다. 공동 전투 재고만 갱신하고 본인의 nearby 결과에만 claimed를 표시한다. SQLite 모드에서는 world 지급 기록·영수증도 재시작 후 복원한다. 상세 요청·응답·신뢰 경계는 [ADR-003](docs/ADR-003-phone-world.md), [protocol.json](protocol.json)을 본다.

## 검증

```powershell
node --test test/*.test.mjs
```

두 독립 소켓 클라이언트를 써서 연결·승인·사격 범위·운전자 권한·중복 처리·출발 중단·재접속·보고 만료를 검증한다. 상속된 객체 키를 좌석으로 넣는 요청, EMPTY→UNKNOWN 잠금 우회, 미승인 데이터 열람, 낡은 보고, 멱등 저장 용량 경계도 시험한다. revision 2는 주행 제한 중 fire 거부/폰 수집 허용, driver 수집 금지, 자가 확인 필수, 같은 fixture 보상 1회, 차량 연결 끊김·낡은 착석과 독립 수집, 주차 지원의 supplies 소비도 검증한다. 결과는 [test-results.json](test-results.json), [receipt-limit-results.json](receipt-limit-results.json)에 기록한다. 이 테스트는 실제 Android APK·실물 폰·Pleos 센서가 연결됐다는 증거는 아니다.

revision 3은 별도 `test/world.test.mjs`에서 위치 필드·거리·정확도·나이·UTC 일정·버전·중복·멱등·폰별 projection·원시 위치 비전파를 검증한다. [world-test-results.json](world-test-results.json)은 HTTP 모의 위치 시험이며 실제 Android GPS/지도 통합시험과 구분한다. 현재 동작 통합시험 3개와 API 계약 확인 2개가 함께 통과한다.

별도 [연결 수명 감사](docs/connection-audit.md)는 90초 격리 생존 시험을 다룬다. lease 만료가 전투만 pause하고 소켓을 닫지 않음을 확인했으며, 실제 APK의 EOF 원인은 아직 확인하지 못했다. 오래 걸리는 감사 도구는 기본 테스트에 자동 포함하지 않는다.

## 신뢰 경계·현재 제한

- HTTP/WS는 로컬 debug 전용이다. 실서비스는 HTTPS/WSS·기기 신뢰·토큰 갱신/폐기·개인정보/보존 정책을 더 구현해야 한다.
- `CAR_HOST` 역할을 자체 발급하는 것은 폐쇄 데모의 편의다. 일반 사용자가 차량으로 인증된다는 의미가 아니다.
- 서버가 게임 규칙을 판정해도 실제 차량 상태를 독립 인증하지 않는다. 앱이 보낸 UNKNOWN을 OCCUPIED/P/허용으로 바꾸지 않는다.
- SQLite 파일과 볼륨을 유지하면 방·세션·통계·획득 원장은 복원된다. 파일 삭제·분실, 기존 게스트 만료, 글로벌 거점·실제 보상·실시간 슈팅 물리/적 AI는 별도 범위다.
- 연결 인증 5초·JSON 16KiB·메시지 속도 제한·일회성 120초 참가 코드·명령 본문 해시 멱등 처리·구형 소켓 교체를 구현했다.
- 승인 대기자는 자신의 참가 상태만 받는다. 차량 신호·다른 멤버·적·실제 통계는 승인 전 snapshot에서 숨긴다.
- 명령 ID는 세션/방 멤버 내 유일해야 한다. 거부된 명령도 같은 ID 재전송 시 같은 결과를 반환한다. 상태를 다시 확인한 사용자의 새 입력은 새 ID를 사용한다.

이 폴더 외의 SDK/에뮬레이터/Android 앱 설치는 다른 구성에서 관리한다.
