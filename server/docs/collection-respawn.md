# 파티 공동 수집과 리스폰 — revision 8

2026-11-02. 서버/API 구현 계약.

- 한 파티에서 먼저 획득한 한 명만 supplies 1을 공동 재고에 추가한다. 다른 파티의 아이템은 유지된다.
- 같은 파티의 모든 폰 nearby에서 해당 항목이 사라진다. 기본 5분 뒤 모두에게 다시 나타난다. `ZRIDE_PICKUP_RESPAWN_MS`로 1000~3600000ms 사이에서 설정한다.
- 마감 시각 `respawnAt`은 서버 시계로 계산하고 지급 기록과 함께 저장한다. 재접속·서버 재시작·UTC 날짜 변경으로 쿨다운을 초기화하지 않는다. 서버가 종료된 동안에도 시간이 지난 항목은 재기동 후 조회에서 다시 제공한다.
- 자동 획득은 하지 않는다. 재등장 후에도 동승자 확인·최신 위치·80m 거리·정확도·측정 나이 검사를 통과해야 한다.

## 폰 구현 순서

1. 승인 후 POST `/api/world/nearby`를 호출한다. `spawns`는 현재 획득 가능한 파티 항목이다. `includeClaimed:true`는 숨겨진 항목의 `claimed`와 `respawnAt`도 제공한다.
2. 선택한 항목의 `spawnId`, `scheduleId`, `version`, **`spawnCycleId`**를 claim 본문에 그대로 넣는다.
3. `collection.changed {roomId, revision, refreshNearby:true}` 또는 `snapshot.collection.revision` 변경을 받으면 지도 캐시를 버리고 nearby를 다시 조회한다. 이전 방/이전 revision에서 시작한 비동기 응답은 폐기한다.
4. 동시에 두 명이 누르면 한 명만 성공한다. 쿨다운 중 `ALREADY_CLAIMED`이면 재조회한다. 리스폰 후 이전 주기의 입력은 `SPAWN_CYCLE_CONFLICT`이므로 새 목록에서 다시 선택한다.
5. 통신 실패 시 같은 commandId와 동일 JSON으로 재전송한다. 과거 성공 영수증 재생은 재고를 추가하지 않는다. 영수증 inventory는 당시 값이며 현재 공동 재고는 snapshot/room 조회로 반영한다.

리스폰 타이머는 알림 시점일 뿐이다. 서버의 실제 deadline 검사가 권위다. 폰 카운트다운은 `serverTime`과 `respawnAt`으로 표시하고, 0초가 되어도 조회·claim 성공 전 지급을 확정하지 않는다.

## 기존 버튼 데모와 저장 이행

좌표 없는 `mobile.collect` DEMO_PICKUP도 파티당 1회·같은 쿨다운을 적용한다. snapshot의 `collectedPickupIds`는 파티 전체가 숨길 항목이고 `pickupRespawnAt`은 버튼 데모 deadline이다. 이 데모 명령은 GPS spawnCycleId 계약과 별개이며 실제 위치 인증이 아니다.

기존 멤버별 지급 기록은 탈퇴한 멤버까지 합쳐 파티 기록으로 이행한다. 기존 재고·성공 영수증은 유지한다. 예전 버튼 데모 기록에 시각이 없으면 첫 업그레이드 시 기본 쿨다운부터 시작한다. QR 재참가로 파티 쿨다운을 우회하지 않는다. 파티 해산 뒤 새 파티는 별도 기록이며 계정 기반 파밍 방지는 아직 구현하지 않았다.

원시 GPS와 상세 스폰 ID는 다른 멤버에게 broadcast하지 않는다. 파티 변경 revision으로 각 폰이 인증된 목록을 다시 조회한다. 최종 iPhone 지도 클라이언트도 이 계약을 구현해야 한다. 참조 Android 지도 어댑터에는 주기 ID 전달과 revision 캐시 무효화를 반영했다.

## 검증

`realtime-collection.test.mjs`: 이동 후 획득, 두 명 경쟁, 공동 재고·사라짐, 별도 파티 분리, 재접속, GPS 비전파.

`respawn.test.mjs`: 쿨다운/UTC 경계, 이전 주기 거부, 영수증 재생, 버튼 재등장, 재시작 deadline 유지, 만료 시 WS 무효화 1회.

`collection-migration.test.mjs`, `persistence.test.mjs`: 이전 탈퇴 멤버 기록 이행 및 SQLite 지급/영수증 복원.
