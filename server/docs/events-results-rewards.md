# 이벤트 회차·미션 결과·공동 기여·보상 — revision 9

2026-11-03 Asia/Seoul. 서버 구현 계약. REST 40개. 기존 장소/접근성/주차 gate/차량 4D의 권한은 유지한다. 최종 차량·폰 게임 화면은 앱 팀이 이 계약으로 연결한다.

## 미션 종류

| scenarioId | 서버 목표 |
| --- | --- |
| zombie-defense-v1 | 서버 좀비 전멸 → COMPLETE |
| heist-demo-v1 | 보급 2 → 서로 다른 폰 2명 단말 상호작용 → 좀비 전멸 → 가상 탈출 100m → COMPLETE |
| supply-run-v1 | 공동 보급 2 확보 → 서로 다른 폰 2명의 인수 확인 → COMPLETE |
| signal-puzzle-v1 | 서로 다른 폰 2명 신호 해독 → 서로 다른 폰 2명 릴레이 동기화 → COMPLETE |

좀비는 SERVER_COMBAT_CLEAR 목표 한 종류다. SHARED_SUPPLIES, UNIQUE_PHONE_INTERACTIONS, VIRTUAL_DISTANCE와 같은 목표를 서버 프리셋으로 조합한다. 임의 클라이언트가 목표 수치/보상/완료를 제출해 바꾸지 못한다. 새 프리셋 추가는 서버 정의/명세 변경이다.

퍼즐은 현재 서버가 승인한 서로 다른 memberId의 단계별 INTERACT를 모으는 데모다. 정답 검증·동시 누르기·현장 방문·서로 다른 실제 사람 인증은 별도다. 보급 2는 확보 조건이며 자동 입장료 차감은 하지 않는다. 운전자 지원은 기존대로 보급 1을 소비한다.

generic-coop-v1은 기존 무한 세션/버튼 전투 참조 모드로 유지하며 이벤트 참가·유한 임무 결과/보상을 만들지 않는다. 이벤트를 하려면 위 유한 프리셋을 configure한다. 신호 퍼즐/보급 확인은 연결된 승인 폰 2명, 좀비/습격은 방어 각도를 커버하는 좌석이 필요하다.

## 앱의 호출 순서

1. 기존 HOST/QR/승인으로 파티 구성. `/api/scenarios`에서 프리셋 조회.
2. HOST가 게임을 멈춘 상태에서 기존 `/api/rooms/{roomId}/game/configure`로 프리셋 선택. 새로운 missionRunId가 생성된다.
3. 기존 `/party`로 검수 승인 거점을 공개 선택. 승인된 참가자는 `GET /api/spots/{spotId}/shared`로 현재 instance를 조회한다.
4. HOST가 **시작 전에** `POST .../party/events/join`으로 현재 회차와 임무를 묶는다.
5. 차량이 신선한 P/UX/foreground 보고 후 명시적으로 round.start. 폰은 기존 수집/fire/game/interact, HOST는 game/advance/game/input을 사용한다. 단계 전환은 서버 목표 충족 후 HOST 요청이다.
6. 서버가 결과를 저장한다. `mission.changed` 또는 snapshot.missionLedger 변경을 받으면 results/rewards를 재조회한다. 성공한 HOST가 `/party/contribute`로 공동 진행에 기여한다.
7. 임무 보상과 공동 이벤트 보상은 PENDING 원장으로 생성된다. HOST가 `/rewards/claim`으로 공동 supplies에 수령한다.
8. 이벤트가 완료/만료하면 COOLDOWN. respawnAt 이후 새 instanceId가 생긴다. 새 missionRunId를 configure하고 새 회차에 다시 참가한다.

```json
{"commandId":"join-unique","spotId":"DEMO_PARKING_SPOT","expectedInstanceId":null}
```

shared.instance가 null인 최초 생성만 expectedInstanceId=null이다. 이미 회차가 있으면 그 instanceId를 그대로 보낸다. 지연된 이전 회차 join은 EVENT_INSTANCE_CONFLICT, 닫힌 회차는 EVENT_NOT_ACTIVE다. 동일 임무를 다른 거점/회차로 다시 묶지 않는다.

```json
{"commandId":"contribution-unique","spotId":"DEMO_PARKING_SPOT","instanceId":"shared에서 받은 현재 ID","expectedInstanceRevision":0}
```

동시에 두 파티가 같은 revision으로 기여하면 하나가 확정되고 다른 요청은 INSTANCE_REVISION_CONFLICT를 받을 수 있다. 최신 shared를 받은 뒤 새 요청으로 재시도한다. 성공 여부가 불명확하면 원래 commandId/본문을 그대로 재전송해 원래 영수증을 확인한다.

## 새 API 4개

| API | 권한 | 내용 |
| --- | --- | --- |
| POST `/api/rooms/{roomId}/party/events/join` | HOST | spotId/expectedInstanceId/commandId로 시작 전 회차 참가 |
| GET `/api/rooms/{roomId}/results` | 같은 파티 승인 멤버 | 임무 결과 원장 |
| GET `/api/rooms/{roomId}/rewards` | 같은 파티 승인 멤버 | PENDING/CLAIMED 보상 원장 |
| POST `/api/rooms/{roomId}/rewards/claim` | HOST | awardId/commandId로 파티 재고에 수령 |

results/rewards의 `offset`은 기본 0, `limit`은 기본 50/최대100이다. nextOffset=null이면 마지막이다. 다른 파티 토큰과 미승인 폰은 거부한다. 파티가 해산되면 기존 파티 접근도 닫히므로 보상 수령은 해산 전에 한다. 계정별 장기 보관/파티 간 재고 이동은 구현하지 않는다.

결과에는 resultId, missionRunId, scenarioId, instanceId, outcome(SUCCEEDED/EXPIRED/CANCELLED), 시각, 참가 멤버/좌석, 단계 이력, 단계별 폰 상호작용과 처치/가상 거리 요약을 저장한다. 현재 게임을 configure해도 결과가 남는다. 상세 원시 GPS/경로/차량 제어 세션은 넣지 않는다.

미션에 참가한 멤버의 기여는 memberId 기준이다. 개인 계정 인증이나 실제 사람 구분을 대신하지 않는다. 좀비는 파티 총 처치 수를 기록하며 개인별 모든 탄환/피해 원장을 추가한 것은 아니다.

## 이벤트 수명과 과거 회차

현재 회차는 ACTIVE이고, 서로 다른 기본 3파티가 각각 성공한 임무를 기여하면 outcome=SUCCEEDED, phase=COOLDOWN으로 바뀐다. 제한 시간이 먼저 끝나면 outcome=EXPIRED로 닫힌다. 성공/만료 회차는 변경하지 않고 respawnAt에 **새 UUID·cycle+1·빈 기여 목록**으로 새 회차를 만든다.

같은 파티는 한 회차에 한 번만 기여한다. 결과는 미션 시작 전에 참가한 instanceId에 묶이므로 지난 클리어/다른 거점/새 회차에 재사용하지 못한다. 같은 이벤트에 다른 프리셋을 수행한 파티가 함께 기여할 수 있다. 공유 보스 HP를 동시에 때리는 실시간 레이드 방식은 추가하지 않았다.

공개 이벤트 시간은 서버 시계이며 파티의 pause 중에도 흐른다. 닫힌 회차에 묶인 전투는 중지되고 새 입력/재개를 거부한다. 목표 파티가 먼저 채워져 이벤트가 닫히면 아직 진행 중인 다른 파티의 임무는 CANCELLED, 시간 만료이면 EXPIRED다. 이미 저장한 성공 결과·기본 임무 보상은 유지하지만 공동 보상은 실제 기여한 파티에만 생성한다.

서버가 오래 꺼져 있었으면 놓친 회차 여러 개를 가짜로 생성하지 않고, 복구 시점에 새 회차 하나를 시작한다. 현재 회차/종료 시각/결과/보상/영수증은 SQLite checkpoint에 저장한다. 폰 타이머는 serverTime과 마감 시각으로 표시하고 서버 응답 전에 완료/수령을 확정하지 않는다.

## 보상 정산

기본값은 **임무 성공 supplies 1 + 공동 이벤트 성공 supplies 2**다. 공동 보상은 기여 파티 각각의 PENDING 원장에 생성한다. 돈·실물 경품·현장 방문 보상이 아닌 기존 데모 게임 자원이다. 보상 수치는 서버 환경 설정이며 run/instance 생성 때 정책을 보존한다.

유일 지급 키는 임무의 run/party 또는 공동 이벤트의 instance/party다. awardId가 다른 것으로 위장하거나 새 commandId를 보내도 이미 CLAIMED인 항목은 REWARD_ALREADY_CLAIMED다. 동일 성공 commandId/동일 본문은 과거 응답을 재생하고 추가 지급하지 않는다. HTTP 영수증 inventory는 당시 값이며 현재 재고는 room snapshot이 기준이다.

수령에서 **공동 재고 증가·CLAIMED 표시·멱등 영수증**을 한 DB checkpoint로 확정한 뒤 ACK/방송한다. 저장 실패 시 서버를 503으로 차단하고 게임 소켓을 종료한다. 재시작하면 마지막 확정 상태부터 복구한다. 메모리 테스트 모드는 재시작 보장이 없으므로 배포에는 기존 dbPath를 유지한다.

이전 revision의 이미 완료된 방은 결과를 보존하되 새 보상을 소급 지급하지 않는다. 과거 공동 인스턴스는 무보상 legacy 회차로 이행하고 완료 회차는 쿨다운 뒤 새 회차를 연다. 이전 성공 기여 영수증은 과거 응답만 재생한다. 과거에 기록하지 않았던 미션 상세 이력은 복원해 만들지 않는다.

## 알림과 안전 게이트

`mission.changed`는 post-commit 조회 갱신 힌트이며 snapshot.missionLedger의 revision/resultId가 복구 기준이다. resultId 또는 missionRunId:COMPLETE로 일회성 연출을 구분하고, 재접속/매 snapshot마다 폭죽·음향을 반복하지 않는다. 예전 내부 mission.completed가 공개 WS로 자동 전달된다고 가정하지 않는다.

공동 기여/이벤트 종료는 같은 회차에 묶인 파티들의 snapshot을 갱신하고 world 구독자에게 새 상태를 알린다. 지급 후에는 같은 파티 재고 snapshot과 collection.changed도 갱신한다. 실제 차량 물리 효과는 기존 현재 연결·TTL·P/UX/로컬 동의/지원 여부 조건을 그대로 사용하며 과거 결과/영수증 재생으로 재실행하지 않는다.

## 환경 설정과 운영 한도

| 설정 | 기본 | 범위 |
| --- | --- | --- |
| ZRIDE_EVENT_DURATION_MS | 1800000 (30분) | 1000~86400000 |
| ZRIDE_EVENT_RESPAWN_MS | 300000 (5분) | 1000~86400000 |
| ZRIDE_EVENT_TARGET_PARTIES | 3 | 1~100 |
| ZRIDE_MISSION_REWARD_SUPPLIES | 1 | 0~100 |
| ZRIDE_SHARED_REWARD_SUPPLIES | 2 | 0~100 |

아이템 5분 리스폰과 이벤트 리스폰은 다른 설정이다. 공개 데모 서버는 위 기본값으로 사용한다. 테스트는 격리 서버에서 1초 쿨다운/목표 2파티로 빠르게 검증한다. 실제 운영 설정을 시험 때문에 낮추지 않는다.

현재 단일 서버/전체 상태 checkpoint 구조를 유지한다. 결과 run·인스턴스 archive·이벤트 명령 영수증 한도는 각각 10000이다. 한도 도달 시 새로운 기록을 차단하고 관리자가 보존/이관 정책을 정해야 한다. 경제 서비스용 영구 회계/다중 서버 확장·자동 archive 삭제는 후속이다. 이번 변경 이후의 최대 동시접속 수치를 새로 측정했다고 주장하지 않는다.

## 검증

- event-ledger.test: 비전투 퍼즐의 단계/기여 결과, 두 파티 공동 완료, mission/shared 보상 1회, 이전 주기 거부, 결과/보상 복원, 만료/취소, 장기 다운타임, legacy 무보상 이행.
- event-integration.test: 실제 REST/WS+SQLite의 두 퍼즐 파티, 동시 기여 revision 충돌, 동일/다른 ID 보상 경쟁, 권한 격리, 지급 저장 실패 주입→503/미방송→재시작 후 1회 지급, 재시작 결과/재고, 1초 뒤 새 instance.
- spots-party-demo: 실제 좀비 방어 프리셋 두 파티가 회차 참가 후 서버 클리어를 기여하며 QR/경로/공유/멱등/SQLite를 유지.

실제 차량 SDK·실물 iPhone 게임 화면·현장 접근 인증은 이 서버 검증과 별도다.
