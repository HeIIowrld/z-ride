# 서버가 관리하는 게임·차량 상태 — revision 6

2026-11-01 (Asia/Seoul). 차량 앱과 폰 게임의 최종 화면이 없어도 서버가 방·역할·임무·자원·가상 이동·차량 상태·4D 실행 상태를 관리하도록 준비한 계약이다. 클라이언트는 입력과 센서 관측을 제출하고, 화면은 서버 snapshot을 기준으로 그린다. 최종 게임 그래픽·맵·AI·실제 Pleos setter 실행까지 완성했다는 뜻은 아니다.

## 상태별 소유권

| 상태 | 서버 책임 | 앱 책임 |
| --- | --- | --- |
| 방·역할·좌석 | 참가·승인·권한·방 lifecycle·epoch | 연결·좌석 요청·승인 화면 |
| 임무·목표 | 시나리오·현재 단계·전환 조건·기여 기록 | 목표 안내·허용된 상호작용 입력 |
| 전투·재고 | 적 HP·각도·명중·피해·공동 보급·지원 자원 확정 | 조준·애니메이션·효과·음향 |
| 가상 이동 | 유효 운전자 입력·속도·누적 거리·서버 시간 계산 | 가속/제동 입력·경로/이동 화면 |
| 차량 신호 | 현재 연결·순서·신선도·UNKNOWN 구분·파생 준비/보호 상태 | SDK capability·area·실제 관측·품질 보고 |
| 4D | 현재 세션에 대한 효과 의도·만료·상태 회신 | 로컬 P/UX·지원·사용자 설정 검사, SDK 실행·실제 callback 확인 |

주차·UX는 기존 방의 공동 전투 조건이다. 폰의 독립 수집과 구분한다. 실제 도로 주행속도로 차량 게임을 계속 실행하는 것이 아니라, 정차 중 게임 속 가상 이동 상태를 관리한다.

## 조회와 입력

`GET /api/rooms/{roomId}/state`는 승인된 같은 방 멤버가 현재 통합 상태를 확인하는 경로다. 기존 GET room과 WebSocket snapshot에도 새 게임·실내 상태가 포함된다. 승인 대기 폰에게는 다른 사람의 전투·차량 상태를 열어주지 않는다.

호스트는 `/game/configure`, `/game/input`, `/game/advance`로 임무 설정·운전 입력·단계 전환을 요청하고, 승인된 PHONE은 `/game/interact`로 목표에 기여한다. `game` 객체를 임의로 PUT하거나 클라이언트가 속도·목표 완료·보상을 성공 처리하는 경로는 없다.

각 POST는 commandId로 중복 적용을 막는다. 설정·명시적 단계 전환은 예상 revision을 검사하고, 반복 입력은 현재 차량 연결/입력 세션·roomEpoch·단조 증가 순서로 검사한다. 늦게 도착한 과거 입력으로 새 장면이 진행되지 않게 한다. 재시도 결과의 과거 상태를 최신 snapshot 위에 덮어쓰지 않는다.

## 제공하는 API와 임무 상태

| 경로 | 권한·요청 | 응답 |
| --- | --- | --- |
| GET `/api/scenarios` | 인증된 CAR_HOST/PHONE | `{scenarios}` — 서버 프리셋·단계·목표 목록 |
| GET `/api/rooms/{roomId}/state` | 승인된 같은 방 멤버 | `{room,serverTime}` — 게임·차량·실내·재고·4D 통합 snapshot |
| POST `…/game/configure` | 호스트, 비PLAYING. commandId·roomEpoch·expectedGameRevision·scenarioId·선택 roleAssignments | `{room,data,replayed}` |
| POST `…/game/input` | 현재 호스트, PLAYING·주차 gate. commandId·roomEpoch·driverSessionId·증가 inputSeq·throttle·brake | 같은 형태. data는 논리 상태, 현재 제어권은 room.game에서 확인 |
| POST `…/game/advance` | 호스트. commandId·roomEpoch·expectedGameRevision, 현재 목표 충족 | 서버가 다음 단계 결정 |
| POST `…/game/interact` | 승인된 PHONE. commandId·roomEpoch·expectedGameRevision·objectiveId·action | 해당 폰의 유효 목표 기여 1회 반영 |
| WS `vehicle.cabin.report` | 현재 차량 소켓. commandId·vehicleConnectionId·증가 reportSeq·신호 관측 | result와 갱신 room.cabin |

기존 REST 15개에 조회 2개·게임 POST 4개를 더해 총 21개다. 게임 명령은 REST POST이며, `game.configure`라는 임의 WS 메시지를 지원한다는 뜻은 아니다. 기존 WS `command`의 fire·mobile.collect·round.start/pause·support.pulse는 유지한다.

기본 `generic-coop-v1`은 기존 COOP 전투 동작을 보존한다. 최종 게임이 아직 정해지지 않아도 기존 방·전투·수집과 일반 가상 이동을 사용할 수 있다. `heist-demo-v1`은 서버 상태·기여·전환 검증용 프리셋이다.

| heist 단계 | 서버가 확인하는 목표 | 다음 단계 |
| --- | --- | --- |
| PREPARE | 공동 보급품 2개 이상. 현재는 준비 조건이며 자동 소모하지 않음 | INFILTRATE |
| INFILTRATE | 서로 다른 승인 PHONE 2명의 TERMINALS/INTERACT 기여 | DEFEND |
| DEFEND | 기존 서버 전투의 모든 좀비 HP 0 | EXTRACT |
| EXTRACT | 서버가 계산한 가상 이동 거리 100m | COMPLETE |
| COMPLETE | 완료 상태, room은 CLEARED | 새 임무는 비PLAYING에서 명시적 configure |

임무 단계는 room.state 안의 하위 상태다. DEFEND에서 적을 모두 잡아도 heist 방은 PLAYING을 유지해 탈출 단계로 진행하고, COMPLETE에서만 CLEARED가 된다. 목표를 확인한 뒤 호스트가 advance를 요청한다. 클라이언트가 다음 stageId나 완료 여부를 지정하지 않는다.

역할은 DRIVER/SCOUT/TECH/COVER이고 기본 매핑은 운전자/앞 동승석/뒤 왼쪽/뒤 오른쪽이다. 호스트만 DRIVER가 될 수 있다. 현재 TERMINALS는 특정 직업 스킬이 아닌 서로 다른 승인 폰 두 명의 기여 조건이며, 직업별 특수 스킬은 아직 구현하지 않았다.

```json
{"commandId":"mission-config-001","roomEpoch":1,"expectedGameRevision":0,"scenarioId":"heist-demo-v1"}
```

configure는 새 missionRunId를 만들고 기존 논리 revision을 이어서 증가시킨다. 응답의 최신 roomEpoch·game.revision을 후속 요청에 사용한다. sceneId는 `missionRunId:stageId`로 만들어 임무 재시작 전후를 구분한다.

## 가상 이동과 입력 만료

`room.game`에는 시나리오·임무 run·단계·목표·역할·속도·누적 거리·경과 시간·revision·motionSeq가 들어간다. `driverSessionId`는 현재 호스트 snapshot에서만 유효한 값이 나오고 폰에는 null이다.

```json
{"commandId":"drive-001","roomEpoch":2,"driverSessionId":"<현재 호스트 snapshot 값>","inputSeq":1,"throttle":1,"brake":0}
```

throttle/brake는 0~1이다. 최종 속도·거리는 서버 tick이 계산한다. 기본 최대 가상 속도는 30m/s, 입력 lease는 2000ms, 한 tick의 계산 시간은 최대 250ms다. 입력이 만료되면 가속을 유지하지 않고 제동한다. pause·연결 교체·단계 전환·재시작은 제어 세션을 무효화하고 속도를 0으로 만든다. 수치는 데모 정책이며 실제 차량 성능·도로 주행 제어와 관계없다.

heist에서 4D 모드를 명시적으로 활성화하면 서버 게임의 sceneId·가상 속도로 바람 의도를 주기 갱신한다. 이때 수동 `/effects/scene` 속도 덮어쓰기는 GAME_SCENE_MANAGED로 거부한다. 일반 COOP의 기존 수동 효과 시연 API는 유지한다. 이 기능은 서버 의도 생성이며 실제 공조 실행을 뜻하지 않는다.

## 영속 게임 상태와 일시적 실행 권한

| 저장·복원 | 재시작·연결 교체 때 초기화 |
| --- | --- |
| 방·승인·재고·획득/멱등 기록 | 소켓·차량 UX/P·foreground·lease |
| 게임 시나리오·단계·목표·누적 논리 진행 | 운전자 입력·가상 속도·입력 세션·마지막 tick |
| 성공한 명령의 논리 결과 | 실내 센서 관측·신선도·파생 보호 효과 |
| 게임 snapshot을 다시 만들 수 있는 데이터 | 4D 활성화·물리 의도·실행 보고·물리 효과 재생 권한 |

서버가 꺼져 있던 시간을 가상 이동 시간으로 보상하지 않는다. 복원 뒤에는 새 차량 보고와 명시적 시작/입력이 필요하다. 게임 진행이 남는 것과 실제 공조 설정을 다시 실행할 권한은 다르다. 저장 실패 시 성공 ACK·snapshot·효과 의도를 전송하지 않는다.

## 차량 신호의 의미

`vehicle.cabin.report`는 현재 인증된 차량 소켓에서만 받는다. 신호별 가용성·측정 나이·출처·샘플 순서를 구분하고, 같은 샘플을 heartbeat에 반복해도 새로운 측정으로 취급하지 않는다. 미지원·권한 거부·알 수 없음·만료를 `false`로 바꾸지 않는다.

```json
{
  "type":"vehicle.cabin.report",
  "commandId":"cabin-001",
  "vehicleConnectionId":"<현재 CAR_HOST auth.ok의 값>",
  "reportSeq":1,
  "hvac":{"sampleSeq":1,"availability":"AVAILABLE","source":"SIMULATED","measuredAgeMs":0,"areaId":"FRONT_ROW","power":true,"fanSpeed":4,"fanMin":0,"fanMax":8},
  "seatBelts":[{"seat":"REAR_LEFT","sampleSeq":1,"availability":"AVAILABLE","source":"SIMULATED","measuredAgeMs":0,"buckled":true}],
  "energy":{"sampleSeq":1,"availability":"AVAILABLE","source":"SIMULATED","measuredAgeMs":0,"socPercent":67}
}
```

위 area·범위·값은 명시적 시뮬레이션 예시다. 실제 앱은 해당 차량의 SDK area·bounds를 사용한다. availability는 AVAILABLE/UNKNOWN/UNSUPPORTED/PERMISSION_DENIED/UNAVAILABLE, source는 PLEOS_READ/PLEOS_CALLBACK/SIMULATED/NONE이다. AVAILABLE이면 타입이 맞는 값·측정 나이 0~60000ms·출처가 필요하고, 그 외에는 source=NONE·값/나이 null 또는 생략이어야 한다.

출력은 입력 measuredAgeMs 대신 서버가 계산한 ageMs·quality(FRESH/STALE/UNKNOWN/UNAVAILABLE)를 포함한다. 신선도 기본값은 6000ms다. 같은 sampleSeq의 같은 값은 허용하지만 서버가 기억한 측정 기점을 새로 만들지 않는다. 같은 순서의 다른 값은 CABIN_SAMPLE_CONFLICT, 과거 순서는 CABIN_STALE_SAMPLE로 거부한다.

벨트 보호와 승무원 준비는 승인 좌석과 신선한 센서 상태를 조합한 서버 파생 상태다. 이는 실제 폰 소지자의 신원을 인증한 값이 아니다. 공조 파생 효과는 지원 범위로 정규화하고, 같은 AIRFLOW 채널을 4D 출력으로 제어하는 동안 자동 출력이 정화 보상을 다시 만드는 자기 강화는 피한다.

차량의 실제 capability·물리 설정·SDK callback 확인과 센서값 의미 검증은 차량 앱 팀의 작업이다. SIMULATED 보고는 실제 SDK 관측과 구분한다. 관제에 값이 보인다고 하드웨어가 독립 검증됐다는 뜻은 아니다.

## 앱 팀이 붙이는 순서

1. 세션·방 참가·좌석 승인 후 REST/WS snapshot을 연결한다.
2. 같은 방의 게임·차량·실내·4D 상태를 화면에 표시한다.
3. 사용자의 역할에 허용된 입력을 보내고 commandId별 결과를 처리한다.
4. 차량 앱은 SDK의 실제 신호와 품질을 보고한다.
5. 효과 의도를 실행할 때는 현재 로컬 조건을 재검사하고 SDK 관측 결과를 보고한다.
6. 연결이 끊기면 입력·물리 효과를 중단하고, 재접속 snapshot으로 복원한다. 과거 사격·가속·물리 의도를 큐에서 재생하지 않는다.

기계 판독 계약은 [OpenAPI](../openapi.json), [WebSocket 계약](../protocol.json), 4D 실행 경계는 [차량 효과 계약](vehicle-effects.md)을 따른다. 최종 맵·물리·적 이동·네이티브 화면 구현은 이 서버 상태 계약 위에 연결한다.

현재 적은 기존 고정 각도·HP 전투 모델이다. 월드 좌표의 적 이동·탄도·최종 게임 AI·실제 차량 액추에이터 동작은 이 상태 준비 작업의 완료 범위가 아니다.

## 앱 없이 서버 흐름 확인

서버를 실행한 뒤 `server` 디렉터리에서 다음 명령으로 차량 1대·폰 2명의 통신을 시뮬레이션한다.

```powershell
node tools/mission-demo.mjs --base http://127.0.0.1:8000
```

외부 테스트 서버에서는 base만 `http://afsd.iptime.org:8000`으로 바꾸고, 접근키가 설정돼 있으면 로컬 환경 변수 `ZRIDE_TEST_ACCESS_KEY`로 전달한다. 키를 명령 인자나 URL에 넣지 않는다. 도구는 실제 API를 통해 보급 수집·두 폰의 목표 기여·전투·100m 가상 이동·임무 완료를 진행한다. 보고 출처는 SIMULATED이며 4D는 RECEIVED까지만 회신하므로 실제 하드웨어 반영을 주장하지 않는다. [시연 도구](../tools/mission-demo.mjs)

[계약 검증 결과](../server-state-validation-results.json)는 새 REST 성공 경로 6/6, 실제 HTTP 응답 25개·요청 5개·실내 WS/상태 샘플 2개와 OpenAPI 예제를 검사한 기록이다. 상태 통합시험은 `node --test --test-concurrency=1 test/server-state.test.mjs`로 실행한다.
