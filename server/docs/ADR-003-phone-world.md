# ADR-003 — 폰 지도·수집 포인트와 위치 입력 검사

2026-11-01. 상태: 코드·서버 단위 통합시험 완료, 실행 중 서비스 재시작·Android 지도 통합시험은 별도 기록. 기존 revision 2의 좌표 없는 DEMO_PICKUP 버튼·전투·차량 신호 동작은 유지한다.

## 결정

지도 타일은 폰 MapLibre가 OpenFreeMap에서 직접 받는다. 게임 서버는 타일·지도 이미지·위치 검색 서비스를 중계하지 않고 **게임 포인트 목록·획득 조건·중복 방지·공동 보급 재고**만 처리한다. 지도 서비스 키나 환경공단 키를 이 API에 새로 요구하지 않는다.

신규 HTTP 경로는 승인된 PHONE 동승자 토큰으로만 사용한다. 차량 호스트·미승인 폰은 거부한다. 폰 지도와 위치 수집은 차량의 주행 중 게임 UI나 VHAL/GPS 백그라운드 중계를 필요로 하지 않는다. 차량 전투와 fire/support의 주차 게이트는 그대로다.

| 경로 | 입력 | 현재 구현 |
| --- | --- | --- |
| POST `/api/world/nearby` | latitude, longitude, radiusM | WGS84 중심에서 최대 2km의 테스트 스폰. 탐색 중심은 GPS 증명이 아님 |
| POST `/api/world/location` | passengerConfirmed, location | 품질 필드 검사·수신 확인. 원시 좌표는 저장하지 않고 품질 메타만 최대 30초 메모리에 유지 |
| POST `/api/world/claim` | commandId, spawnId, scheduleId, version, passengerConfirmed, location | 거리·정확도·나이·서버 스폰 일정·중복·멱등 검사 후 supplies 1 지급 |

좌표가 URL·접근 로그에 노출되는 GET query 대신 인증된 POST JSON을 채택했다. 앱 서버는 요청 본문·원시 위치를 기록하지 않는다. HTTPS·역방향 프록시·운영 로그 설정은 실제 배포 때 별도로 검증해야 한다.

## 테스트 포인트와 실제 충전소의 구분

| spawnId | latitude | longitude |
| --- | --- | --- |
| SEOUL_CITYHALL_TEST_A | 37.5665 | 126.9780 |
| SEOUL_CITYHALL_TEST_B | 37.5669 | 126.9783 |
| SEOUL_CITYHALL_TEST_C | 37.5659 | 126.9775 |

세 좌표는 서울 시청 주변에 배치한 **테스트 게임 지점**이다. 실제 충전소·안전한 주차면·방문 허가 장소라고 검증한 자료가 아니다. 각 항목은 `pointKind=TEST_GAME_POINT_NOT_CHARGER`를 제공한다. 출시용 거점은 공식 시설 ID 연결과 접근·정차 가능성 검수가 추가로 필요하다.

스폰은 `worldVersion=seoul-demo-v1`, UTC 날짜 scheduleId, Unix milliseconds opensAt/expiresAt을 제공한다. claim은 목록의 scheduleId·version을 필수로 돌려보낸다. 현재 UTC 일정이 바뀌면 지난 스폰 선택은 거부한다. 같은 멤버·spawn·UTC 일정에는 한 번만 보상을 준다.

## 위치 판정의 의미

초기 정책은 **반경 80m, 보고 정확도 0 초과·50m 이하, 측정 나이 0~10초**다. 제품의 테스트 초기값이며 공식 Pleos 요구 수치나 물리적 실제 위치 보증이 아니다. 지도 화면 중심·타일 로딩·새 콜백 수신만으로는 claim을 허용하지 않는다.

폰은 `hasAccuracy()`를 확인한 Android `Location`의 정확도와 같은 장치의 monotonic clock으로 계산한 측정 나이를 보낸다. `getElapsedRealtimeNanos()`는 부팅 이후 측정 시각이며 다른 장치의 clock과 직접 비교하지 않는다. 정확도는 추정 수평 반경으로 확률적 값이다. [Android Location 공식 명세](https://developer.android.com/reference/android/location/Location)

응답 `locationValidated=true`는 **서버가 클라이언트가 보고한 좌표·품질·거리 조건을 검사했다**는 뜻이다. `hardwareAttested=false`를 함께 반환한다. 클라이언트 위치·시간·소스가 위조되지 않았다는 증명은 없으며, 실제 GNSS 하드웨어 인증·실제 현장 방문을 완성했다고 표현하지 않는다.

`source=EMULATOR_GPS` 또는 `MOCK`, 또는 isMock=true이면 `validationTier=MOCK_DEMO`다. 에뮬레이터의 geo fix가 isMock=false로 제공돼도 source가 EMULATOR_GPS이면 테스트로 구분한다. 일반 입력은 CLIENT_REPORTED이고 신뢰 증명이 추가되는 것은 아니다.

기존 `mobile.collect`의 좌표 없는 DEMO_PICKUP 버튼은 별도 유지하며 gpsVerified=false다. 이 버튼 성공을 지도 위치 검사 성공으로 표시하지 않는다.

## 저장·전파·권한

- 원시 폰 좌표·이동 경로를 보관하거나 다른 폰/차량 snapshot에 넣지 않는다.
- claim 영수증은 요청 본문의 해시·서버 결과·일정별 지급 여부만 메모리에 둔다. API 응답의 거리·스폰 ID는 요청자에게만 제공한다.
- 공동 snapshot에는 보급 수량과 `pickupId=WORLD_CLAIM`의 요약만 보낸다. 다른 폰이 어느 실제 좌표 스폰을 획득했는지 상세 목록은 공개하지 않는다.
- nearby의 `claimed`는 해당 요청자의 멤버 기준이다. 다른 동승자의 claim 목록을 공유하지 않는다.
- location 보고는 현재 claim의 선행 인증이 아니다. claim마다 새 위치 본문을 다시 검사한다.
- 새 commandId로 같은 스폰을 반복하면 ALREADY_CLAIMED다. 같은 ID·같은 본문 재전송은 저장된 영수증을 돌려주고 보상을 반복하지 않는다. 같은 ID·다른 본문은 충돌이다.
- claim 응답의 inventory는 **그 claim이 최초 확정된 시점의 영수증 값**이다. 나중에 보급을 추가 획득한 뒤 오래된 영수증을 재전송해도 이 값은 바뀌지 않는다. 현재 공동 재고는 기존 WS snapshot/room 조회가 권위이고 HTTP 영수증으로 최신 상태를 덮어쓰지 않는다.
- 현재 guest 세션·메모리 저장 방식이라 서버 재시작 시 방·claims·재고가 사라진다. 계정 신뢰·새 게스트 재가입 파밍·영속 원장은 후속 과제다.
- 원시 좌표가 없어도 멤버와 스폰 ID·UTC 일정의 연결은 방문을 추론하게 하는 기록이다. 현재 메모리 claim 기록은 서버 실행 중 보관되고 재시작 때 사라지며, 별도의 자동 보존기간 삭제 정책은 구현되지 않았다. 출시 전 적정 보유·삭제·동의/철회 정책을 정해야 한다.

## 정책·법령상 남은 범위

Pleos 차량 게임은 주행 시작 때 중지·UI 숨김·주행 중 재개 금지를 유지한다. 독립 폰 수집을 허용하는 제품 선택과 차량 게임의 예외를 혼동하지 않는다. [Pleos 주의 분산 기준](https://document.pleos.ai/docs/pleos-only/distribute/app-review-guide/review-driver-distraction-elements)

폰 좌표를 짧게 처리하거나 저장하지 않더라도 서버로 전송해 사용하는 데이터 흐름은 존재한다. 이용 항목·목적·전송·보유·거부·철회를 앱 안에서 설명하고 운영 주체에 맞는 절차를 확인해야 한다. OS 위치 권한과 서비스의 고지·동의를 동일시하지 않는다. Pleos도 최소 권한·고지·동의 및 국가별 위치정보 등록/신고 확인을 안내한다. [Pleos 개인정보·보안](https://document.pleos.ai/docs/pleos-only/distribute/app-review-guide/review-user-privacy-security)

위치정보법 제18조는 위치정보사업자의 개인위치정보 수집에 관한 약관 명시·동의 사항을 규정한다. 실제 사업자 유형·수집/이용/제공 관계에 따라 적용을 확인해야 하며, 이 기술 문서가 등록·신고·법률 검토 완료를 뜻하지 않는다. [국가법령정보센터 제18조](https://law.go.kr/LSW/lsLinkCommonInfo.do?chrClsCd=010202&lsJoLnkSeq=1029559615)

## 시험과 남은 확인

`test/world.test.mjs`는 승인·권한, POST 좌표, WGS84 필드 순서, 범위 상한, 낡은 fix·낮은 정확도·거리 초과, 일정/버전, 중복/멱등, 에뮬레이터 출처, 다른 폰에 대한 raw 위치 비전파를 검사한다. [결과](../world-test-results.json)

시험 입력은 HTTP 클라이언트의 모의 위치다. 실제 Android Location callback→폰 지도→claim, 지도 렌더링 성능·출처 고지, 실제 실물 폰 GPS·현장 위치는 후속 통합시험에서 구분해 기록한다.
