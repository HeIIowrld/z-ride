# 실제 Pleos 내비 SDK 연결

2026-11-04 Asia/Seoul. 참조 차량 앱은 공식 Maven의 NaviHelper3.0.5/navi-data3.0.4를 사용한다. `requestRoute`, `requestReRoute`, `cancelRoute`, `getCurrentLocationInfo`, `getDestinationInfo`, `getRouteStateInfo`, `requestNavigationScreen`과 공개 `NaviHelperEventListener`만 호출한다. InternalApi·리플렉션·숨겨진 차량 API는 사용하지 않는다.

## 통신 흐름

웹 차량 페이지의 ‘실제 Pleos 내비 SDK’ → 고정 목적지/재탐색 요청 → AVD private 디버그 명령 → 실제 NaviHelper → OEM 내비 → SDK callback → NavigationRelayService → 현재 HOST의 인증된 WS `navigation.report` → 승인된 폰 `snapshot.navigation` 순서다. HTTP 요청 성공은 요청 전달만 뜻하며 실제 결과는 SDK 상태로 확인한다.

폰은 목적지·상태·SDK 관측 경로 revision·남은 거리/시간·차량 위치 갱신 여부를 표시한다. reportSeq 역전·PHONE 위조·승인 전 구독·다른 방 접근은 기존 인증과 신규 검증에서 차단한다. SDK 상태는 SQLite checkpoint에 저장하지 않고 재연결/재시작 때 초기화한다. 위치 샘플은10초 내 freshness가 필요하며 평범한 heartbeat로 낡은 좌표를 되살리지 않는다. 관제/공개 SDK 상태 endpoint에는 원시 SDK 좌표·주소/목적지 이름을 추가하지 않는다. 계정은 기존 Google/게스트·QR·차량 승인 구조를 유지한다.

SDK 관측 revision은 SDK callback/목적지 응답 변화를 앱이 관찰한 순서다. OEM 경로 ID/도로 형상 버전을 보장하는 값이 아니다. 지도 앱 구현에 따라 완료·재탐색 콜백 일부가 제공되지 않을 수 있으므로 ‘요청 반환’만으로 완료를 만들지 않는다.

## 내비 화면을 열어도 유지되는 서비스

운전자가 Pleos 내비로 전환하면 PLY Activity가 화면에서 내려갈 수 있다. PLY의 내부 foreground service가 SDK 구독·차량 읽기·기존 HOST WS 연결을 유지한다. 알림 ‘차량 내비 상태 연결 중’이 표시된다. HOST 자격증명은 RoomClient 프로세스 메모리에만 두고 Intent·URL·공개 상태 JSON으로 넘기지 않는다. 게임 Activity를 다시 열면 같은 RoomClient/파티에 재부착한다. 앱이나 서비스 프로세스를 종료하면 연결이 끊긴다.

Activity가 내려가면 vehicle.report.foreground=false이며 UX 제한·P 조건·6초 차량 lease가 계속 적용된다. 서비스는 게임 화면/게임 오디오/4D 출력을 실행하지 않고 APP_MAPS나 distractionOptimized 선언으로 게임 제한을 피하지 않는다. 새로운 차량 연결마다 telemetry sequence를 리셋하지 않으며 UI 재생성에도 같은 연결의 sequence는 증가한다.

## 시연

1. [차량1](https://hyundai.hjpark.net/vehicles/1)에서 서버 연결·QR 발급 → 폰 Google/게스트 참가 → 차량 승인.
2. ‘실제 Pleos 내비 SDK’를 펼쳐 목적지A를 누르고 SDK 결과를 확인한다.
3. ‘주행 D ·30km/h’, ‘GPS 다음 시험 지점’으로 에뮬레이터 GNSS와 차량 신호를 변경한다.
4. 목적지B 또는 ‘실제 내비 재탐색’을 요청하고 폰의 SDK 목적지/상태/revision 변화를 확인한다. SDK 완료 callback이 없으면 요청 완료로 표시하지 않는다.
5. ‘주차P’ → ‘내비 안내 취소’로 복귀한다. 차량 앱이 보이지 않으면 Pleos 앱 목록에서 Z-RIDE Car Probe를 다시 열면 된다. 파티 연결은 서비스에 남아 있다.

공개 운영 경로는 GET/POST `/vehicles/navigation/{1|2|3}`다. POST는 동일 Origin·고정 action만 허용하며 임의 좌표/URL/ADB/명령을 입력받지 않는다. public GET은 서비스 연결·상태·콜백·오류·관측 revision만 반환한다. 소프트웨어 렌더러의 다중 AVD 안정성 한계는 [운영 가이드](pleos-emulator-hosting.md)와 동일하며1대가 기준이다.

## 도로 형상과 GPS 시험의 한계

NaviHelper3.0.5의 TripSummary.routePoints는 POI/경유 지점 요약이며 전체 도로 폴리라인이 아니다. 이 점들을 직선으로 이어 `PLEOS_ROUTE`라고 등록하지 않는다. SDK 모드 진입은 이전 DEMO_ROUTE geometry를 해제하고 `snapshot.navigation.geometryAvailable=false`를 전달한다. 실제 내비 도로 형상으로 경로 주변 스팟을 계산하는 부분은 공인 도로 형상을 공급받기 전까지 활성화하지 않는다. 외부 라우팅을 연결할 경우에도 출처를 구분해야 한다.

‘GPS 다음 시험 지점’은 여의도 합성 좌표를 Android GNSS에 보낸다. Pleos 2.1.0 차량 이미지에서는 체크섬을 수정해 Android 위치가 바뀌어도 순정 내비가 보고하는 위치와 남은 거리가 고정되는 것을 확인했다. 내비 거리·시간은 SDK 응답을 표시한다.

AVD 시험에서 `getCurrentLocationInfo`가 GNSS 변경을 즉시 따라가지 않는 경우를 확인했다. 차량 위치는 위치 권한이 허용되면 Android GNSS를 우선 읽고 `positionSource=ANDROID_GNSS`로 표시한다. NaviHelper 위치만 있는 경우에는 `PLEOS_NAVI_HELPER`로 구분한다. Android GNSS 업데이트를 SDK 경로/재탐색 완료 callback이라고 간주하지 않는다. foreground service는 위치 권한이 있을 때만 location 유형과 GPS 구독을 활성화하며, 권한이 없으면 SDK 목적지 상태 연결만 유지한다. 실물 차량/아이폰 검증과 실제 도로 재생은 별도다.

`DEMO_ROUTE`를 재생할 때는 경로를 설정할 당시 Virtual Console이 보고한 주행 가능 거리에서 재생한 거리를 빼서 계기판에 보낸다. 예를 들어 콘솔에서 99 km로 시작하고 1 km를 재생하면 98 km가 된다. 시작값이 없거나 0이면 그대로 두며, 일시 정지 중에는 차감하지 않는다. 순정 내비의 목적지까지 남은 거리는 NaviHelper 응답을 표시한다.

## 순정 내비 모의주행과 계기판 동시 녹화

1. 로컬 Pleos 2.1.0 시험 인스턴스에서 Z‑RIDE Car Probe를 실행하고 순정 내비로 판교 시험 경로 안내를 시작한다.
2. 순정 내비의 시작 화면에서 길게 누르기 동작으로 Developer Menu를 연다. 검증에서는 Android UiAutomation이 시작 화면의 `long-clickable` 노드에 `ACTION_LONG_CLICK`을 보냈다. 재시작 확인이 뜨면 ‘계속 안내’를 선택한다.
3. `Developer Menu → TAS Test → onSimulatedDriveRequestTest`에서 순정 내비 자체 모의주행을 시작한다. 아래 녹화 명령을 먼저 실행한 경우 명령이 화면의 Test 버튼을 누르고 메뉴를 닫는다. 좌표는 2560×1440 시험 화면 기준이다.

```sh
python tools/verify-native-drive.py --serial emulator-5560 \
  --start-button 1344 607 --close-menu 1450 200 --range-m 99000 --seconds 54 --video native-drive.mp4
```

녹화 도구는 같은 목적지와 경로에서 NaviHelper의 순정 경로 인덱스가 증가하고 남은 거리가 줄어들 때 계기판의 시연용 주행 가능 거리에서 같은 양을 차감한다. 첫 구간의 시작값은 `--range-m`으로 정하고, 이어지는 구간에서는 이 옵션을 생략해 Virtual Console의 현재 주행 가능 거리를 이어받는다. 주행 기어와 속도는 Virtual Console에서 설정한다. 판교 시험에서 순정 내비 1,200 → 590 m, 계기판 신호 99,000 → 98,390 m, 계기판 표시 99 → 98 km를 확인했다.

디버그 앱의 로컬 목적지 명령에 `waypoint` 객체(`latitude`, `longitude`, `name`)를 넣으면 SDK의 `requestRouteWithWaypoints`로 경유지와 목적지를 한 번에 요청한다. 경유지 목록과 도착 이벤트는 Pleos 앱에서 읽는다. 녹화에서 경유지 및 최종 도착 이벤트까지 검증하려면 `--require-waypoint --require-arrival`을 지정한다.

## 검증과 출처

서버 테스트는 HOST 권한·승인된 폰 전파·역순/위조 거절·DEMO geometry 해제·freshness·영속 저장 제외를 검사한다. 실제 SDK 서비스 연결, 약관 동의 상태, 목적지 요청 후 ROUTE_DRIVE·목적지·남은 거리/시간 응답을 AVD에서 확인했다. 이동/재탐색·폰 최종 결과는 별도 실제 검증 기록으로 구분한다.

[공식 SDK 가져오기](https://document.pleos.ai/en/docs/pleos-only/connect-sdk-pleos/NaviHelper/importing-sdk) · [목적지](https://document.pleos.ai/en/docs/pleos-only/connect-sdk-pleos/NaviHelper/destinations) · [재탐색](https://document.pleos.ai/en/docs/pleos-only/connect-sdk-pleos/NaviHelper/routes) · [callback](https://document.pleos.ai/en/api-reference/connect-sdk-pleos/NaviHelper/event-listeners) · [3.0.5 좌표 인자 변경](https://document.pleos.ai/en/docs/pleos-only/release-note/sdk-261015).
## 실제 이용 흐름

목적지와 경유지는 Pleos 내비에서 설정한다. PLY에서는 주차 중 **크루 로비 열기**로 파티를 만들고 동승자를 초대한다. 로비는 내비 경로 없이도 열 수 있다. Pleos 내비에서 안내를 시작하면 PLY가 NaviHelper에서 안내 상태를 읽어 파티에 전달한다. 승인된 동승자는 폰에서 주행 중 보급품과 게임을 이용할 수 있다.

공유 에뮬레이터의 고정 목적지·재탐색·취소 버튼은 위 시연 절차에서 사용한다.
