# 앱 팀 전달용 서버 연결 계약 — revision 3

2026-11-01. 현재 `server.mjs`·`world.mjs`·`protocol.json`에서 확인한 **구현된 로컬 데모 계약**이다. REST의 타입·필수값·예제·응답·오류는 [OpenAPI 3.1](../openapi.json), WS는 아래 별도 부록과 [protocol.json](../protocol.json)을 기준으로 한다. 제안 경로를 구현된 API처럼 추가하지 않았다.

## 담당과 전달물

| 담당 | 맡을 범위 | 앱 팀에 전달할 것 |
| --- | --- | --- |
| 사용자: 서버·API·통신·인프라 | 세션·방·승인·획득·게임 판정, 메시지 계약, 오류·멱등·상태 버전, 배포 연결 | 이 문서, OpenAPI, 테스트 결과, 사용할 base URL |
| 차량 앱 팀 | Pleos UX/P/foreground·착석 신호 어댑터, 차량 UI·로컬 중단, 관제·지원 입력 | 아래 vehicle.report를 실제 가용 신호로 구성. 미상 신호를 허용으로 바꾸지 않음 |
| 폰 앱 팀 | 지도·위치 권한·위치 측정·UI·수집 입력, snapshot 반영 | nearby/claim 요청, 위치 source·age·accuracy 표시, 동승자 자기 확인 |
| 함께 확인 | ID·enum·단위·에러 처리, 주행 전환·재접속·중복 요청 | 양쪽 앱의 같은 roomId·stateVersion, 서버 통합시험 |

MapLibre 위젯이나 SDK 화면 구현은 앱 팀 범위다. 서버는 지도 타일을 중계하지 않고 게임 지점·획득·공동 보급만 판정한다.

## 접속 환경과 인증

- PC: `http://127.0.0.1:8000`, `ws://127.0.0.1:8000/ws`.
- Android Emulator: `http://10.0.2.2:8000`, `ws://10.0.2.2:8000/ws`.
- 실제 폰에서 `10.0.2.2`를 사용하지 않는다. 현재 서버는 기본 loopback이므로 실물 폰 연결용 주소·바인딩·네트워크 노출은 별도 인프라 작업이다. 원격 HTTPS/WSS 서비스가 배포됐다고 간주하지 않는다.
- `POST /api/session`만으로 CAR_HOST/PHONE 게스트 토큰을 발급한다. 계정 로그인·차량 인증이 아니며 서버를 닫힌 데모 환경으로 취급한다.
- `/healthz`, `/api/session` 외 REST에는 `Authorization: Bearer <token>`을 넣는다. `/api/observer/rooms`는 게임 토큰 대신 별도 운영자 관찰키를 사용한다. 토큰은 URL·지도 요청·로그에 넣지 않는다. 현재 구현은 `Bearer ` 접두사를 정확히 검사한다.
- 세션 유효기간은 8시간이며 refresh/logout/삭제 API는 없다. CLI는 SQLite에 세션 조회 해시·방·획득·재고·멱등 영수증을 저장하고 원래 만료 범위에서 복원한다. 프로그램에서 dbPath/stateStore를 생략한 시험 서버는 메모리 전용이다. [영속화 계약](persistence.md)을 따른다.

## REST 10개 — 구현된 경로만

모든 성공/오류 본문은 JSON이며, 오류 모양은 `{"error":{"code":"MEMBER_PENDING","message":"Waiting for vehicle approval"}}`이다. 본문을 파싱하는 경로는 JSON 객체·최대 16KiB를 받는다. `POST /api/rooms`는 본문을 읽지 않는다.

| 메서드·경로 | 호출자 | 성공 응답·핵심 처리 |
| --- | --- | --- |
| GET `/healthz` | 공개 | 200: ok=true, protocol, contractRevision=3, rooms. 저장 실패 시 503·ok=false |
| POST `/api/session` | 공개 | 201: sessionId, token, expiresAt(Unix ms), role |
| POST `/api/rooms` | CAR_HOST | 새 방 201 / 기존 방 코드 갱신 200: roomId, joinCode, room |
| POST `/api/join` | PHONE | 201: roomId, memberId, pending=true, 본인만 보이는 room |
| POST `/api/rooms/{roomId}/approve` | 해당 방 CAR_HOST | 200: 호스트 관점 room |
| GET `/api/rooms/{roomId}` | 해당 방 멤버, pending 포함 | 200: 호출자 권한에 맞춘 room |
| POST `/api/world/nearby` | 승인된 PHONE 동승자 | 200: spawns, scheduleId, worldVersion, locationPolicy |
| POST `/api/world/location` | 승인된 PHONE 동승자 | 200: 선택적 위치 품질 영수증. claim의 선행 조건 아님 |
| POST `/api/world/claim` | 승인된 PHONE 동승자 | 200: 최초/재전송 영수증. 보급 1회 지급 |
| GET `/api/observer/rooms` | 별도 운영자 관찰키 | 읽기 전용 방 요약 목록. 기본 비활성, 게임 세션 토큰 불가 |

world 경로는 인증·승인 멤버 확인 후 POST 외 요청에 405 `METHOD_NOT_ALLOWED`를 돌려준다. 좌표를 GET query에 넣지 않는다. 그 외 잘못된 경로·메서드는 404이며 인증이 먼저 적용될 수 있다.

## 방 연결 순서

1. 차량: `POST /api/session {"role":"CAR_HOST","nickname":"차량"}` → 받은 토큰을 유지한다.
2. 차량: `POST /api/rooms` → roomId·joinCode를 보관하고 `/ws`를 인증한다.
3. 폰: 자기 `PHONE` 세션을 만든 뒤 `POST /api/join {"joinCode":"현재 코드","seat":"FRONT_PASSENGER"}`.
4. 차량: pending snapshot의 **memberId**로 approve를 호출한다. sessionId·token과 혼용하지 않는다.
5. 폰: 같은 token·roomId로 WS 인증 후 snapshot을 반영한다. pending 상태에서도 연결/GET은 되지만 차량·다른 멤버·적 정보는 가려진다.
6. 차량: 실제 신호 report를 보낸다. 주차 전투는 조건이 충족돼도 호스트의 명시적 `round.start`가 필요하다.

참가 코드는 **120초·1회 사용**이다. 다음 폰을 추가할 때 기존 차량 토큰으로 `POST /api/rooms`를 다시 호출하면 같은 방에서 코드만 갱신된다. 차량 세션을 새로 만들면 새 방이 된다. 방은 host+폰 3명이며 pending도 정원에 포함된다. 이미 참가한 폰은 join을 반복하지 않고 같은 토큰으로 재접속한다.

approve의 `seat`는 생략/null이면 기존 요청 좌석을 유지한다. PLAYING 중 승인된 멤버의 좌석 변경은 거부된다. `allowManualUnknown:true`는 현재 UNKNOWN일 때 이전 EMPTY 잠금을 수동으로 푸는 명시적 동의이며 탑승자 신원 증명이 아니다.

## 이동 수집 요청

폰 지도·수집은 주차 전투와 분리된다. 승인된 폰 역할과 `passengerConfirmed:true`를 검사하며, 차량 host 연결·UX/P·foreground·착석 신선도·roomEpoch는 world 획득 조건이 아니다. 이것은 실제 운전자/탑승자 판별을 완료했다는 뜻이 아니다.

```json
{"latitude":37.5665,"longitude":126.978,"radiusM":500}
```

위 본문을 nearby로 보내고 응답의 `spawnId`, `scheduleId`, `version`을 그대로 사용한다. 현재 지점 3개는 서울 시청 주변 `TEST_GAME_POINT_NOT_CHARGER`이며 실제 충전소 데이터가 아니다. radiusM은 생략/null이면 500, 숫자는 1~2000m다. `claimed`는 요청한 멤버 본인의 상태다.

```json
{
  "commandId":"claim-001",
  "spawnId":"SEOUL_CITYHALL_TEST_A",
  "scheduleId":"2026-11-01",
  "version":"seoul-demo-v1",
  "passengerConfirmed":true,
  "location":{
    "latitude":37.5665,"longitude":126.978,
    "accuracyM":5,"measuredAgeMs":500,
    "source":"EMULATOR_GPS","isMock":false
  }
}
```

위 claim의 일정은 예시다. 반드시 현재 nearby의 서버 UTC 날짜를 사용한다. 좌표는 WGS84 **latitude/longitude**, 거리는 m, 나이는 ms다. 정확도는 0 초과·50 이하, 측정 나이는 0~10000, 서버 지점과의 거리는 80m 이하다. source는 `ANDROID_GPS / ANDROID_NETWORK / ANDROID_FUSED / EMULATOR_GPS / MOCK` 중 하나다.

`locationValidated:true`는 제출 값의 형식·품질·거리 조건 통과다. `hardwareAttested:false`이며 좌표·시간·동승자 여부가 독립 인증된 것은 아니다. source가 EMULATOR_GPS/MOCK 또는 isMock=true이면 `MOCK_DEMO`; 일반 입력도 `CLIENT_REPORTED` 수준이다.

- 같은 멤버·spawn·UTC 일정의 보상은 한 번이다. 새 ID로 반복하면 `ALREADY_CLAIMED`다.
- 전송 결과를 못 받았을 때 **같은 commandId·같은 JSON 값**으로 재시도한다. measuredAgeMs까지 수정하면 `IDEMPOTENCY_CONFLICT`다. 새 위치를 쓰는 새 시도에는 새 commandId를 쓴다. world는 객체 키 순서를 정규화하지만 값은 그대로여야 한다.
- 성공 영수증의 `inventory`는 당시 값이다. `replayed:true`일 때도 과거 재고가 유지된다. 최신 재고는 GET room/WS snapshot이 권위이며 영수증으로 덮어쓰지 않는다. HTTP 영수증에 currentInventory/stateVersion 필드는 없다.
- claim은 snapshot broadcast 후 HTTP 결과가 도착할 수 있다. HTTP와 WS 이벤트 순서를 가정하지 않는다.
- 원시 fix를 저장·전파하지 않는다. world claim에는 공유 snapshot의 `lastCollect.pickupId=WORLD_CLAIM`만 남긴다. 멤버별 spawnId·UTC 일정 기록은 방문을 추론할 수 있어 보존 정책 대상이다. SQLite에 보존하는 지급 기록에는 별도 자동 삭제 기간이 없다.

## 오류 처리와 재연결

| code/상황 | 앱 처리 |
| --- | --- |
| AUTH_REQUIRED / AUTH_EXPIRED | 토큰 누락 확인. 만료·DB 초기화/유실이면 새 세션·새 방/참가 절차. 정상 영속 재시작은 기존 토큰/방 유지 |
| MEMBER_PENDING | 승인 대기 UI; world/전투 재시도로 우회하지 않음 |
| PAIRING_EXPIRED / PAIRING_USED / ROOM_NOT_FOUND | 기존 차량 세션에서 코드 갱신. 방 소멸인지 구분 |
| SEAT_TAKEN / REASSIGN_REQUIRES_PAUSE | 좌석 선택 재확인 / 먼저 명시적 pause |
| STALE_EPOCH / GATE_CLOSED / NOT_PLAYING | 최신 snapshot 반영, 전투 입력 중단; 자동 전투 재개 금지 |
| LOCATION_INACCURATE / LOCATION_STALE | 폰에서 새 측정 대기. source·정확도·나이 확인 |
| OUTSIDE_SPAWN / SPAWN_EXPIRED / WORLD_VERSION_CONFLICT | 현재 위치·nearby 갱신. 원격 획득 성공처럼 표시하지 않음 |
| RATE_LIMITED / COMMAND_LIMIT | 반복 전송 중단·지연. COMMAND_LIMIT은 이 데모의 보관 한도이며 무한 재시도하지 않음 |
| WS EOF/네트워크 끊김 | 로컬 전투 즉시 중단, 연결 상태 표시. EOF만으로 서버 idle timeout이라고 단정하지 않음 |

재연결 구현은 앱 팀 과제이며 현 앱에 자동 재접속이 완성됐다고 가정하지 않는다. 서버가 살아 있고 세션이 유효하면 **같은 token·roomId로 WS 재인증 → 새 snapshot → 차량의 새 report → 호스트의 명시적 start** 순서다. 폰 membership/획득 상태는 같은 세션에 유지된다. SQLite가 유지된 서버 재시작 후에도 원래 만료 전 token·roomId가 유효하다. 복원 직후 모든 소켓은 끊긴 상태, 차량 UX/기어 UNKNOWN·foreground=false·전투 PAUSED다. 새 차량 보고는 과거 영수증과 다른 새 commandId를 사용하고 명시적으로 시작해야 한다. battle 명령을 오프라인 큐에 쌓아 재연결 뒤 발사하지 않는다.

## WS 별도 부록 — `/ws`

OpenAPI의 REST operation으로 등록하지 않았다. 연결 후 **5초 안에 첫 JSON 메시지**를 보낸다. 토큰을 URL query에 넣지 않는다.

```json
{"type":"auth","token":"HTTP에서 받은 토큰","roomId":"받은 room UUID"}
```

서버는 `auth.ok {sessionId,memberId}`와 `snapshot {room:...}`을 보낸다. 이후 매 입력에는 1~128자 commandId가 필요하다. `result {commandId,ok,data|error,roomEpoch}`로 처리 결과를 받는다. 메시지 바깥 단계의 파싱/인증/중복 충돌 오류는 commandId=null, roomEpoch 생략일 수 있으므로 null도 처리한다.

```json
{
  "type":"vehicle.report","commandId":"report-001","reportSeq":1,
  "ux":"ALLOWED","gear":"P","foreground":true,
  "seats":[{"seat":"FRONT_PASSENGER","occupancy":"UNKNOWN"}],
  "source":"PLEOS_VEHICLE_CALLBACK",
  "charge":{"state":"UNKNOWN","portConnection":"UNKNOWN","source":"NONE"}
}
```

- report는 CAR_HOST만 보낸다. UX=`ALLOWED/RESTRICTED/UNKNOWN`, gear=`P/R/N/D/UNKNOWN`, 착석=`OCCUPIED/EMPTY/UNKNOWN`. source·charge는 표시용 주장이고 독립 인증이 아니다. reportSeq는 **연결별 증가 정수**로 보내며 재인증 때 1부터 시작한다. 생략도 허용되는 구형 계약이지만 순서 보호를 위해 항상 보낸다.
- 권장 report 간격은 2초다. 전투 gate는 host WS 연결·수신 6초 이내·UX ALLOWED·P·foreground=true다. 만료는 PAUSED 전환이며 WS를 닫지 않는다. 차량은 서버 응답을 기다리기 전에 로컬에서 게임·UI를 중단한다.
- EMPTY는 UNKNOWN/누락만으로 풀리지 않는다. 새 OCCUPIED 또는 현재 UNKNOWN에서 호스트의 명시적 수동 재승인이 필요하다. SDK Boolean 의미가 미검증이면 UNKNOWN으로 전달한다.

| action | 권한·조건 | 결과 |
| --- | --- | --- |
| round.start | 호스트, 현재 epoch·주차 gate, 연결된 승인 폰 1명 이상·해당 좌석 비EMPTY | 시작/재개, epoch 증가. CLEARED 후에는 적 HP 초기화 |
| round.pause | 승인 멤버, 오래된 epoch도 허용 | PLAYING이면 PAUSED·epoch 증가 |
| support.pulse | 호스트, PLAYING·현재 epoch·gate, supplies ≥1 | 보급 1 소비, 5초 동안 적중 피해 3. 보급 없으면 SUPPLY_REQUIRED |
| fire | 승인 동승자, PLAYING·현재 epoch·gate·비EMPTY·좌석 각도 | 서버가 적중·피해·HP 판정. 평상시 피해 1 |
| mobile.collect | 승인 동승자·passengerConfirmed=true | 좌표 없는 DEMO_PICKUP fixture. 차량/epoch 독립, gpsVerified=false |

```json
{"type":"command","commandId":"fire-001","roomEpoch":1,"action":"fire","angleDeg":60}
```

각도는 -180~180°, 0=전방, +90=우, -90=좌, ±180=후방이다. FR [-45,90], RL [-180,-45], RR [45,180]이며 경계 중첩을 허용하고 양쪽 후석은 ±180 모두 허용한다. 호스트 사격은 금지한다. 이 좌석 구간은 게임 규칙이다.

`stateVersion`은 같은 방의 snapshot 갱신 순서이고 `roomEpoch`는 전투 세대다. 최신 snapshot의 epoch를 전투 명령에 넣는다. `mobile.collect`와 world는 epoch gate와 독립이다. WS 명령 멱등 fingerprint는 **파싱 후 JSON 키 순서까지 포함**하므로 재시도할 때 저장한 메시지를 그대로 보낸다. world의 키 정규화와 혼동하지 않는다. WS는 실패 결과도 보관하므로 고친 입력은 새 ID를 사용한다.

동일 멤버의 새 WS는 이전 연결을 4409로 교체한다. 4401은 인증 실패/5초 timeout/수신 시 확인된 세션 만료, 4429는 보관 명령 10000개 도달이다. WS는 최대 16KiB, 세션별 10초당 120메시지이며, 별도 앱 heartbeat/pong 계약은 없다. HTTP는 IP별 10초당 120회, world는 추가로 세션별 30회다. [연결 감사](connection-audit.md)의 실제 idle 시험과 오류 범위를 함께 확인한다.

## 검증과 남은 인프라

[검증 결과](../openapi-validation-results.json): OpenAPI 3.1 문서·모든 내부 참조·요청/응답 예제 통과. 임시 로컬 서버에서 REST 10/10 성공 경로, 응답 35개·유효 요청 16개를 스키마와 대조했다. `node --test test/openapi-contract.test.mjs`는 protocol.json의 실제 경로·정책과 계약 일치를 검사한다. 앱/AVD 통합 결과는 별도 evidence이며 이 검증이 실물 GPS 인증을 뜻하지 않는다.

**후속 제안이며 미구현:** TLS·원격 배포 주소/프록시·로그 정책, 정규화된 대규모 원장·보존/삭제, 신뢰 가능한 계정/차량 자격, 실물 폰 네트워크 검증, 충전소 데이터와 시설 ID, bbox/cell/nonce, 운영 모니터링. 기존 확장 제안의 optionalSignals·벨트/HVAC·스피커 제어는 현 서버 계약에 포함되지 않는다.

## 관제 화면·저장 장애 추가 계약

실제 제품 관제 UI는 /observer, 읽기 전용 채널은 /observer/ws다. 운영자 키로 목록을 조회하거나 자신의 방 호스트 토큰으로 연결하고 참가자별 서버 상태 재구성을 관찰한다. 실제 폰/차량 화면 픽셀 중계는 아니다. 별도 observer.auth, 이벤트·권한·만료·redaction은 [관제 계약](observer.md)에 정리했다. 관찰 접속은 게임 소켓을 교체하거나 게임 명령을 실행하지 않는다.

SQLite 저장 실패 시 REST는 STORAGE_UNAVAILABLE 503, health는 ok=false인 503을 반환한다. 성공 ACK·갱신 snapshot을 보내지 않고 관제도 미커밋 메모리를 읽지 못한다. 앱은 로컬 보상을 만들지 않고 재접속/재시작 후 저장된 영수증과 최신 snapshot으로 결과를 확인한다. DB를 복구하고 재시작하기 전 메모리 전용으로 우회하지 않는다.
