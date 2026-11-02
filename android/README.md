# Z-RIDE Android 최소 데모

2026-11-01. 서버와 차량 앱·폰 앱의 통신, 실제 Pleos/AAOS 읽기 API 진단, 좌석별 사격각을 보여주는 **개발용 native Android 프로토타입**이다. HTML·WebView는 사용하지 않는다.

## 앱

| 모듈 | 패키지 | 역할 |
| --- | --- | --- |
| carapp | `ai.zride.demo.car` | CarUxRestrictions·기어·EV 속성·착석 진단, 방 생성·참가 승인, 라운드 시작·지원 펄스 |
| phoneapp | `ai.zride.demo.phone` | 코드 참가·좌석 선택, 서울 실지도·폰 위치·서버 지점 수집, 차량 상대각 사격 |
| common | 라이브러리 | HTTPS/디버그 HTTP·표준 WebSocket 클라이언트, native Canvas 부채꼴·좀비 표적·HP |

운전자는 사격하지 않고 지원 펄스로 동승자의 피해를 돕는다. 앞 동승석은 -45..90°, 뒷좌석 좌측은 -180..-45°, 우측은 45..180°다. 0°는 차량 전방, 양수는 오른쪽이다. 이는 게임 규칙이며 실제 차량의 사격·창문 제어와 무관하다. 서버가 승인·좌석·각도·현재 라운드·주차 상태를 검사한다.

## 빌드

- AGP 8.7.3 / Gradle 8.9 / JDK 17 / compileSdk 34 / minSdk 28 / targetSdk 34.
- SDK Platform 34의 optional `android.car.jar`가 컴파일에 필요하다. `carapp`에서 `useLibrary 'android.car'`를 사용한다. Pleos 2.1.0 런타임의 실제 공유 라이브러리 이름은 `ai.pleos.playground.car`이므로 manifest는 이를 required, `android.car`는 optional로 선언한다. 일반 AAOS AVD용 배포 설정과 구분한다.
- Vehicle SDK `ai.pleos.playground:Vehicle:2.3.2`, vehicle-data 1.1.11. 공식 Maven 저장소에서 받는다.
- OkHttp 4.12.0으로 HTTP·표준 WebSocket 연결. Gradle wrapper는 공식 v8.9.0 파일, 배포 ZIP은 공식 SHA-256을 고정했다.
- v0.3.0/code3은 phoneapp에만 MapLibre Native Android `org.maplibre.gl:android-sdk:12.3.1` OpenGL을 추가했다. x86_64를 포함하며 현재 compileSdk34·AGP8.7.3과 빌드/lint를 검증한다. 최신 13.7.1 OpenGL은 APK 조립은 됐으나 Kotlin2.2 metadata가 이 lint 도구와 맞지 않아 실제 선택 버전과 구분했다.

```powershell
$env:JAVA_HOME='C:\Users\jeff4\Projects\Z-RIDE\tools\jdk\jdk-17.0.21.0.2+1'
$env:ANDROID_HOME='C:\Users\jeff4\AppData\Local\Android\Sdk'
.\gradlew.bat :carapp:assembleDebug :phoneapp:assembleDebug --no-daemon --console=plain
```

APK 출력: `carapp/build/outputs/apk/debug/carapp-debug.apk`, `phoneapp/build/outputs/apk/debug/phoneapp-debug.apk`.

`local.properties`는 로컬 경로이므로 Git에서 제외했다. Debug manifest에만 평문 HTTP를 허용한다. Release는 HTTPS/WSS가 필요하며 배포용 인증·보안·저장·심사 구현은 아직 아니다.

## 실행

서버 시작은 `../server/README.md`를 따른다. PC 서버는 기본 127.0.0.1:8000, AVD는 `http://10.0.2.2:8000`을 입력한다. 실제 폰은 PC LAN 주소·서버의 LAN binding·방화벽 또는 USB 개발용 `adb reverse tcp:8000 tcp:8000`이 필요하다. AVD 전용 `10.0.2.2`를 실제 폰에 쓰지 않는다.

```powershell
adb -s <carSerial> install -r carapp\build\outputs\apk\debug\carapp-debug.apk
adb -s <phoneSerial> install -r phoneapp\build\outputs\apk\debug\phoneapp-debug.apk
adb -s <carSerial> shell am start -n ai.zride.demo.car/.MainActivity --es serverUrl http://10.0.2.2:8000 --ez autoConnect true
```

차량의 방 코드로 폰을 참가시키고, 차량 화면에서 명시적으로 승인한다.

```powershell
adb -s <phoneSerial> shell am start -n ai.zride.demo.phone/.MainActivity --es serverUrl http://10.0.2.2:8000 --es joinCode <code> --es seat FRONT_PASSENGER --ez autoConnect true
```

Intent extras: `serverUrl`, `nickname`, `joinCode`(폰), `seat`(폰), `autoConnect`. 자동 연결과 아래 테스트 액션은 debuggable APK 및 localhost/127.0.0.1/10.0.2.2 서버에 한정한다. 실물 폰이 없고 두 번째 AVD로 검증했다면 실물 폰 시험과 구별해 기록한다.

## 클릭 없는 개발용 테스트

AVD의 Windows 창을 표시하거나 클릭할 필요 없이 adb와 Intent로 테스트할 수 있다. 이것은 Android의 주행 게임 제한을 푸는 기능이 아니다. 차량 앱은 실제 UX·P·foreground 상태를 계속 검사하고, 테스트 명령에 차량 상태를 강제로 허용하는 필드는 없다.

처음 연결할 때만 Activity를 실행한다. 이후 명령은 debug manifest에만 등록된 BroadcastReceiver로 현재 Activity의 같은 RoomClient에 전달한다. Receiver는 sender에 android.permission.DUMP를 요구하고 debuggable·loopback 서버 조건을 다시 검사한다. 일반 제3자 앱 호출은 허용하지 않는다. Activity를 재실행하거나 foreground를 강제로 허용하지 않는다. 앱이 준비되지 않으면 최대 15초 기다린 뒤 test.rejected를 기록한다.

```powershell
adb -s <carSerial> shell am broadcast -a ai.zride.demo.DEBUG_COMMAND -p ai.zride.demo.car --es testAction approvePending
adb -s <carSerial> shell am broadcast -a ai.zride.demo.DEBUG_COMMAND -p ai.zride.demo.car --es testAction roundStart
adb -s <phoneSerial> shell am broadcast -a ai.zride.demo.DEBUG_COMMAND -p ai.zride.demo.phone --es testAction fire --ef testAngleDeg 60
adb -s <carSerial> shell am broadcast -a ai.zride.demo.DEBUG_COMMAND -p ai.zride.demo.car --es testAction supportPulse
adb -s <carSerial> shell am broadcast -a ai.zride.demo.DEBUG_COMMAND -p ai.zride.demo.car --es testAction inspectCabin
```

허용 testAction은 connect, approvePending, roundStart, roundPause, fire, supportPulse, inspectCabin, soundOn, soundOff, collect다. game의 action 결과는 private `files/last-action-result.json`, 추가 진단은 `files/cabin-state.json`에 저장한다. 별도 기기·권한을 우회하지 않고, 수신한 SDK 콜백·서버 판정을 확인하는 용도다. 일반 release APK에서는 테스트 액션이 동작하지 않는다.

폰 지도용 testAction은 `gpsRefresh`, `mapRefresh`, `mapFocusGPS`, `mapSnapshot`, `worldClaim`이다. worldClaim은 추가 `--es spawnId <서버 ID> --ez passengerConfirmed true`가 필요하다. 차량 상태나 폰 좌표를 앱의 테스트 인자로 덮어쓰는 기능은 없다. 에뮬레이터 GPS 입력은 별도의 공식 `adb emu geo fix longitude latitude`로 설정하고, Android LocationManager 콜백을 통해 들어오는지 확인한다.

```powershell
adb -s <phoneSerial> shell am broadcast -a ai.zride.demo.DEBUG_COMMAND -p ai.zride.demo.phone --es testAction collect --es pickupId DEMO_PICKUP_A --ez passengerConfirmed true
adb -s <carSerial> shell am broadcast -a ai.zride.demo.DEBUG_COMMAND -p ai.zride.demo.car --es testAction soundOn
```

## 동승자 수집과 주차 전투

폰의 독립 수집 패널은 차량 전투가 PAUSED여도 유지된다. 승인된 동승자가 ‘운전자가 아니며 동승자입니다’를 명시적으로 체크해야 수집 명령을 보낸다. 현재는 DEMO_PICKUP_A/B/C 세 테스트 지점이며 **GPS 기반 수집을 구현·인증한 것은 아니다.** 운전자 역할은 수집하지 않는다. 서버가 파티 전체의 같은 지점 중복 수집을 막고 공동 supplies를 저장한다. 기본 5분 뒤 파티 모두에게 재등장한다.

차량의 지원 펄스는 주차·UX 전투 게이트를 통과하고 supplies 1개를 소모해야 사용할 수 있다. 효과는 서버가 계산하는 5초 피해 3이며, 자원이 없으면 거부된다. 따라서 폰의 수집이 주차 후 협동 지원으로 이어진다. battle 사격·차량 game UI는 주행 중 계속 금지한다. Android 백그라운드 게임을 강제로 허용하는 기능은 없다.

## 진단·안전 동작

- CarUxRestrictions 현재값·변경 콜백이 주 판단이며, 기어 P를 추가 조건으로 쓴다. UNKNOWN은 잠금이다. 게임 Activity에 distractionOptimized를 선언하지 않는다.
- UX 제한·P 이탈·앱 숨김 때 차량 입력을 로컬에서 먼저 막고 gamePanel을 숨긴다. 서버 응답을 기다리지 않는다. 서버는 2초 보고·6초 lease를 별도로 확인한다. 복귀 후 자동 라운드 시작하지 않는다.
- CarPropertyManager에서 기어, EV_CHARGE_PORT_CONNECTED, EV_CHARGE_STATE, 포트 개폐·스위치·배터리·AAOS Seat의 지원·읽기·구독 결과를 별도로 남긴다. 읽기 전용이며 어떤 차량 설정도 쓰지 않는다.
- `EV_CHARGE_STATE`는 API34 public `EvChargeState` 상수로 매핑한다. 포트 열림·Charge Switch는 실제 케이블 연결·충전 상태를 대신하지 않는다.
- AAOS CAR_ENERGY runtime 권한은 자동으로 요청하지 않는다. 기본 진단·연결을 방해하지 않도록 사용자가 `충전 정보 권한 요청 (선택)` 버튼을 누를 때만 요청한다. Pleos normal `CAR_ENERGY` 경로의 SOC capability·조회·구독도 별도로 제공하며 SOC 증가를 실제 충전 중 인증으로 해석하지 않는다.
- API34의 AAOS SEAT_OCCUPANCY는 일반 sideload 앱에 권한이 없을 수 있다. 특권 권한을 얻으려 하거나 hidden API로 우회하지 않는다. **Pleos Vehicle Seat의 normal 권한**으로 capability·현재값·구독을 별도로 검사한다.
- Pleos initialize는 비동기 서비스 연결이다. 초기 오류와 지원 없음은 구분해 기록하며 시작 1.5초·5초에 capability를 재시도한다. 좌석과 폰은 수동 승인으로 매칭하며 착석 센서가 사람을 식별하는 것은 아니다.
- 센서 미상으로 수동 매칭한 참가자는 서버 `MANUAL_UNKNOWN`, 검증된 EMPTY는 사격 차단이다. UX·P 미상은 차량 전투 잠금이다. 독립 폰 수집은 이 전투 게이트와 구분한다.
- Pleos Emulator 2.1.0/Vehicle2.3.2에서 Console 착석과 SDK Boolean 역전이 관찰됐다. SDK 원문은 raw 정수==1을 occupied로 바꾸는데 표준 enum은 VACANT1/OCCUPIED2라 의미 검증이 필요하다. 앱은 자동 반전하지 않고 `rawSdkSeatOccupied`를 그대로 남기며 `UNVERIFIED_SEMANTICS`를 표시한다. 검증된 AAOS 값이 없으면 서버에 `occupancy=UNKNOWN`으로 격리하고 좌석 역할은 수동 승인으로 시연한다.

## 벨트·공조·도어·창문·조명과 효과음 확장

추가 진단은 Seatbelt, HVAC power/AC/fan speed/current °C/target °C, door/window position, ambient brightness/color의 capability·READ를 확인한다. 벨트·공조 power·fan은 변경 구독과 해제를 포함한다. normal 권한만 추가하며 setter·자동 공조 변경·벨트 조작·도어/창문 제어는 하지 않는다. 미지원·접속 오류·권한 오류는 서로 구분해 진단한다. 추가 값은 게임 서버에 중계하지 않고 기기 내 진단 카드와 private 파일에만 남긴다.

효과음은 기본 OFF이고 사용자가 켜거나 debug soundOn을 요청할 때만 가능하다. USAGE_GAME과 AudioFocusRequest를 사용하며, 게임 실행 허용·foreground·서버 PLAYING 조건을 모두 만족해야 짧은 자체 생성 음을 재생한다. 포커스 상실·게임 중지·앱 숨김·연결 단절 때 즉시 정리하고 포커스가 돌아왔다고 자동 재생하지 않는다. 앱 내 amplitude는 기본 6%, 최대 15%이고 시스템/차량 전체 음량은 바꾸지 않는다. 음원 파일·마이크 권한은 필요 없다.

오디오는 시스템 기본 경로다. 개별 좌석 스피커·오디오 존·차량 fade/balance를 제어했다고 주장하지 않는다. 재생 시 포커스 결과·AudioTrack 상태·재생 프레임·기본 라우트 type을 로그로 검증할 수 있지만, 로그만으로 실차 스피커의 청감·방향까지 검증된 것은 아니다.

## 폰 실지도·위치·서버 지점 수집 v0.3

폰에 Native MapView를 넣고 OpenFreeMap Liberty 스타일의 실제 서울 도로·건물·지명을 렌더링한다. 초기 카메라는 서울시청 37.5665,126.978 / zoom16 / tilt40이다. Liberty의 기존 `building-3d` 레이어를 사용하며 OSM 기반 높이는 정밀 측량·S-Map 원본이라는 뜻이 아니다. 외부 브라우저·HTML·WebView는 사용하지 않는다. 연결 뒤 입력 폼은 접어 지도와 지점이 상단에 보이게 한다.

위치는 차량 SDK와 별도로 **폰 Android LocationManager**의 실제 콜백을 쓴다. 사용자가 위치 권한을 명시적으로 허용할 수 있고, 미허용·미수신 때에는 서울 지도 탐색 모드로 동작한다. 측정 위치의 나이는 같은 장치의 elapsedRealtimeNanos 차이이며 callback 수신 시각으로 바꾸지 않는다. accuracy 미상·50m 초과·10초보다 오래된 측정으로는 수집하지 않는다. 에뮬레이터는 `EMULATOR_GPS`로 표시하며 Location.isMock 실제 값도 그대로 보낸다.

```text
POST /api/world/nearby
{latitude, longitude, radiusM:500}

POST /api/world/claim
{commandId, spawnId, scheduleId, version, passengerConfirmed:true,
 location:{latitude,longitude,accuracyM,measuredAgeMs,source,isMock}}
```

두 요청은 기존 RoomClient의 Bearer 인증을 사용한다. URL query에 위치를 넣지 않고 서버에 POST한다. nearby는 최소 5초 간격이며 지도 중심의 탐색 결과는 방문 증명이 아니다. 지점은 서버가 보낸 ID·WGS84 좌표·버전·UTC schedule·유효시간·80m 수집 반경을 사용한다. 현재 세 지점은 **테스트 게임 지점이며 실제 충전소가 아니다.** UI에는 이 점을 표시하고 기존 DEMO_PICKUP 버튼도 유지한다.

서버가 거리·정확도·측정 나이·참가 역할·중복을 검사하더라도 client-reported 위치라는 한계가 남는다. `locationValidated:true`를 하드웨어 인증으로 설명하지 않는다. 응답의 `hardwareAttested:false`, 에뮬레이터 `validationTier:MOCK_DEMO`를 유지한다. HTTP 영수증의 inventory로 최신 공동 재고를 덮어쓰지 않고 기존 WebSocket snapshot을 사용한다.

MapView 생명주기 전체를 전달하고 phone pause에서는 위치 구독을 해제한다. OpenFreeMap 요청과 자체 서버 인증 클라이언트는 별개이며 지도 요청에 참가 토큰을 싣지 않는다. MapLibre 기본 UA의 applicationId/version 경로를 사용하고 오프라인 타일 묶음을 다운로드하는 기능은 없다. 지도 타일 서비스에는 조회 지역·접속 정보가 전송될 수 있다.

검증 파일은 앱 private 영역에 둔다.

| 파일 | 증거 |
| --- | --- |
| `files/map-state.json` | styleLoaded, realMapSourcePresent, building3dLayerPresent, fullyRenderedFrame, snapshotSaved, 실제 위치의 source/accuracy/age, nearby 수신과 오류 |
| `files/map-snapshot.png` | style와 fully-rendered frame 이후 SDK native snapshot. API JSON 수신만으로 렌더 성공을 표시하지 않음 |
| `files/world-nearby.json` | 서버 원본 spawn 목록·schedule·정책 |
| `files/world-last-result.json` | claim 원본 성공/거부, hardwareAttested·validationTier 또는 로컬 위치 미준비 |

앱 화면에 © OpenStreetMap contributors · OpenFreeMap · MapLibre를 표시한다. 지도만의 SDK bitmap을 문서·영상에 사용할 때도 주변 캡션에 같은 출처를 함께 표시한다. 실제 렌더·GPS·수집 실행 결과는 root의 headless 검증 기록과 분리해 확인한다.

### v0.3 실제 APK·에뮬레이터 검증 결과

2026-11-01 root의 headless 통합 검증에서 기존 협동 흐름 20개와 새 지도·위치·서버 흐름 8개가 통과했다. 지도 검증의 원본은 [phone-map-integration-results.json](../evidence/phone-map-integration-results.json)이다.

- MapLibre Native가 OpenFreeMap 실지도 source와 Liberty style을 읽고 fully-rendered frame 및 building-3d 레이어를 확인했다.
- 서울 도로·한글 지명·3D 건물이 그려진 [SDK 지도 bitmap](../evidence/phone-seoul-map.png)과 [폰 화면](../evidence/phone-map-screen.png)을 저장·검토했다. 지도 출처: © OpenStreetMap contributors · OpenFreeMap · MapLibre.
- Android LocationManager에서 에뮬레이터 GPS callback을 수신했다. 정확도 5m, source=EMULATOR_GPS이며 isMock=false였지만 서버는 하드웨어 인증으로 보지 않고 MOCK_DEMO로 구분했다.
- 차량 Drive/전투 pause 중 폰의 시청 테스트 지점 A 수집이 성공했고 WebSocket으로 차량 공동 supplies가 0→1로 반영됐다.
- 같은 지점 재수집은 ALREADY_CLAIMED, 새 GPS 측정이 반경 밖이면 OUTSIDE_SPAWN으로 거부했다.

실물 폰·현장 방문, 실제 충전소 POI, GPS 하드웨어 인증, 영구 재고 저장은 이 결과에 포함되지 않는다. 서버가 클라이언트의 거리·품질을 검사하는 범위와 실제 위치 진실성을 구분한다.

진단 로그는 logcat tag `ZRideDiag`와 앱 private `files/diagnostics.jsonl`에 남긴다. 토큰·참가 비밀값은 로그에 남기지 않는다. 현재 방 snapshot은 private `files/room-state.json`에만 남긴다. Debug의 `adb run-as`로 확인할 수 있으므로 공개 영상에 참가 코드·닉네임을 노출하지 않는다.

```powershell
adb -s <carSerial> logcat -d -s ZRideDiag:I
adb -s <carSerial> shell run-as ai.zride.demo.car cat files/diagnostics.jsonl
adb -s <carSerial> shell run-as ai.zride.demo.car cat files/room-state.json
```

빌드 성공과 AVD 실수신·실제 폰 연결·실차 충전 시험은 별도로 기록한다. 이 코드는 차량 주행 게임, 실제 도어/충전 제어, GPS 하드웨어 인증, 공공 충전기 API, 영구 보상 저장을 구현하지 않는다. 폰 Native 지도·Android 위치·서버 거리 검사 수집은 v0.3에서 추가했으며 에뮬레이터와 실물 폰의 검증 수준을 구분한다.

## 공식 참고·의존성

- [Pleos 주행 제한](https://document.pleos.ai/docs/pleos-only/vehicle-app-developer-guide/driving-restriction-development-guide)
- [CarUxRestrictionsManager](https://developer.android.com/reference/android/car/drivingstate/CarUxRestrictionsManager)
- [CarPropertyManager](https://developer.android.com/reference/android/car/hardware/property/CarPropertyManager)
- [Android14 VehiclePropertyIds 원문](https://android.googlesource.com/platform/packages/services/Car/+/refs/heads/android14-release/car-lib/src/android/car/VehiclePropertyIds.java)
- [Android14 EvChargeState 원문](https://android.googlesource.com/platform/packages/services/Car/+/refs/heads/android14-release/car-lib/src/android/car/hardware/property/EvChargeState.java)
- [Vehicle 2.3.2 공식 POM](https://nexus-playground.pleos.ai/repository/maven-releases/ai/pleos/playground/Vehicle/2.3.2/Vehicle-2.3.2.pom), [소스](https://nexus-playground.pleos.ai/repository/maven-releases/ai/pleos/playground/Vehicle/2.3.2/Vehicle-2.3.2-sources.jar)
- [AGP8.7 호환성](https://developer.android.com/build/releases/agp-8-7-0-release-notes)
- [MapLibre Native Android](https://maplibre.org/maplibre-native/android/), [12.3.1 공식 소스](https://github.com/maplibre/maplibre-native/tree/android-v12.3.1/platform/android)
- [OpenFreeMap 사용](https://openfreemap.org/quick_start/), [Android Location](https://developer.android.com/reference/android/location/Location)

OkHttp와 Gradle/Android 공개 코드의 라이선스 고지 및 Pleos SDK 약관은 각각 적용된다. 원본 SDK를 우리 오픈소스 코드로 재라이선스하지 않는다. Canvas 도형·좀비 표시는 이번에 작성한 단순 도형이며 외부 게임 자산을 복제하지 않았다.
