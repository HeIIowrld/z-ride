# Pleos 게임 연동 가이드 (브리지 v1)

웹 게임을 Z-RIDE Pleos 앱(`android/pleoshub`, 패키지 `ai.zride.hub`)에 올리는 방법이다.
게임 담당은 **웹 페이지 두 장(차 화면·폰 화면)과 게임 서버**만 만들면 된다. 차와 이어지는 부분은 이 폴더의 `zride-car.js` 한 파일이 맡는다.

## 구조

```text
[Pleos 차 화면]  Z-RIDE 게임 앱 (허브)
   게임 목록 → 고른 게임의 "차 화면 URL"을 WebView로 연다
   └ zride-car.js ← 차 신호(배터리·기어·속도·주차)   → 실내 요청(무드등·공조)
        │ WebSocket 등(게임마다 자유)
[게임 서버]  각자 만든 서버 (Node 등)
        │
[폰 2~4대]  브라우저로 QR 찍고 참가(앱 설치 없음)
```

- 허브는 게임 규칙을 모른다. 페이지를 띄우고, 차 신호를 넘기고, 실내 요청을 안전 조건에 맞춰 적용만 한다.
- 게임 서버와 폰 통신 방식은 자유다. 예시는 `games/electric-thief`(WebSocket)를 본다.

## 1. 차 화면 페이지에 SDK 넣기

`games/sdk/zride-car.js`를 게임의 정적 파일로 내보내고(복사하거나 서버에서 이 경로를 읽어 제공), 차 화면 HTML에서 게임 스크립트보다 먼저 불러온다.

```html
<script src="/zride-car.js"></script>
<script src="/host.js"></script>
```

```js
const car = ZRide.car;

// 차 신호. 바뀔 때마다 온다(앱 안에서는 최대 1초 간격으로 확인).
car.on('signal', s => {
  // s = { v: 1, soc: 57, gear: 'P', ux: 'ALLOWED', speedKmh: 0, visible: true, parked: true }
  if (!s.parked) showCover();          // 주행 중이면 화면을 가린다
});

// 실내 연출 요청. 적용됐으면 true, 주차 중이 아니면 false(요청은 기억했다가 다시 주차되면 적용)
car.setCabin({ light: 'RED', climate: 'COLD' });
car.pulse('RED', 800);                 // 무드등을 잠깐만 바꿨다가 원래 요청으로(최대 5초)
car.reset();                           // 게임이 끝나면 원래대로
car.exit();                            // 허브 게임 목록으로
```

| 값 | 뜻 |
|---|---|
| `car.inCar` | Pleos 허브 앱 안에서 열렸는지 |
| `car.mocked` | `?mockcar` 가짜 차 패널을 쓰는 중인지 |
| `car.state` | 마지막 신호. 차가 없으면 `null` |
| `car.cabin` | 마지막으로 요청한 실내 상태 |
| `car.info` | `{version, app, gameId, lights, climates}` |

### 신호 필드

| 필드 | 값 | 비고 |
|---|---|---|
| `soc` | 0~100 또는 `null` | Pleos `EvBattery` 실제 배터리 % |
| `gear` | `P` `R` `N` `D` `UNKNOWN` | AAOS `GEAR_SELECTION` |
| `ux` | `ALLOWED` `RESTRICTED` `UNKNOWN` | AAOS 주행 UX 제한 |
| `speedKmh` | 숫자 또는 `null` | AAOS `PERF_VEHICLE_SPEED`. 권한이 없으면 `null`. 런타임 권한이라 지금은 `adb shell pm grant`로 준다. 에뮬레이터에서 실제 값이 들어오는지는 아직 확인 못 함 |
| `visible` | true/false | 허브 화면이 보이는 중인지 |
| `parked` | true/false | **P단 + UX 허용 + 화면 표시**. 실내 연출은 이때만 적용된다 |

### 실내 요청 값

| 항목 | 값 |
|---|---|
| `light` | `NORMAL`(원래 값) `OFF` `RED` `BLUE` `GREEN` `YELLOW` `PURPLE` |
| `climate` | `NORMAL`(원래 값) `COLD`(16°C) `WARM`(28°C) |

허브는 바꾸기 전 원래 무드등·온도를 저장해 두고, `NORMAL` 요청·주행 시작·게임 닫기·앱 종료 시 되돌린다. 앱이 강제로 죽어도 다음 실행 때 되돌린다.

## 2. 차 없이 개발하기 (`?mockcar`)

일반 브라우저에서 차 화면 주소 뒤에 `?mockcar`를 붙이면 왼쪽 아래에 **가짜 차 패널**이 뜬다.

- 배터리 슬라이더, 기어 P/R/N/D, 속도 슬라이더가 있고, 게임이 요청한 실내 상태(색·공조)를 보여 준다.
- P가 아니면 앱과 똑같이 실내가 원래대로 돌아가고 `parked: false` 신호가 간다.
- 패널은 Shadow DOM이라 게임 CSS나 `Content-Security-Policy: style-src 'self'`의 영향을 받지 않는다.

`?mockcar`가 없고 차도 없으면 신호가 오지 않는다(`car.state === null`). 이때 게임은 자체 시연 모드로 돌면 된다.

## 3. 허브에 게임 등록하기

`android/pleoshub/src/main/assets/games.json`에 한 줄 추가한다.

```json
{ "id": "parking-escape", "title": "주차장 좀비 탈출", "scene": "PARKED", "players": "2–4명", "summary": "한 줄 설명", "url": "http://10.0.2.2:8220/" }
```

- `scene`: `CHARGING`(충전 중) · `PARKED`(주차 중) · `DRIVING`(이동 중, 폰 위주). 목록 표시용이다.
- `url`: 차 화면 페이지 주소. `null`이면 목록에 "준비 중"으로 흐리게 나온다.
- 에뮬레이터에서 PC의 서버는 `10.0.2.2`다. 포트는 게임마다 다르게 정한다(전기 도둑 8210, 충전 릴레이 8200).
- 디버그 빌드는 다시 빌드하지 않고 주소를 바꿀 수 있다:

```bash
adb shell am start -n ai.zride.hub/.HubActivity --es url.parking-escape http://10.0.2.2:8220/ --es game parking-escape
```

`--es game <id>`는 목록을 건너뛰고 그 게임을 바로 연다.

## 4. 안전 규칙 (허브가 지킴)

- 실내 연출은 `parked`일 때만 적용된다. 그 밖의 요청은 무시하고 `false`를 돌려준다.
- D단 등 주행 UX 제한이 걸리면 허브가 즉시 원래 값으로 되돌린다. Pleos도 허브 화면을 시스템 차단 화면으로 덮는다.
- 게임 페이지는 등록한 주소의 출처(scheme+host+port) 밖으로 이동할 수 없다. 브리지는 열린 게임 페이지에만 답한다.
- 차 설정은 무드등 밝기·색과 좌석 설정 온도만 건드린다. 창문·도어·주행 관련 값은 다루지 않는다.

### 이동 중 게임(DRIVING)에 대해

AAOS는 주행 중에 일반 앱 화면을 막는다. 그래서 **이동 중 게임은 폰 화면이 주인공**이고, 차 화면은 정차 중 로비·결과용으로 쓴다.
주행 중에도 `speedKmh`·`gear` 신호는 페이지로 계속 가지만, 화면이 가려진 동안 WebView 스크립트가 계속 도는지는 아직 실차·에뮬레이터로 확인하지 않았다. 주행 중 속도를 게임 서버로 보내야 하면 먼저 같이 확인하자.

## 5. 에뮬레이터에서 확인하기

```bash
cd android && ./gradlew :pleoshub:assembleDebug
```

```bash
adb install -r android/pleoshub/build/outputs/apk/debug/pleoshub-debug.apk
```

```bash
adb shell pm grant ai.zride.hub android.car.permission.CAR_SPEED
```

```bash
adb forward tcp:8088 tcp:8088
```

Virtual Console(http://127.0.0.1:8088)에서 Battery SOC, Gear Selection, Climate Power, 온도를 바꿔 가며 본다. 공조가 꺼져 있으면 온도 변화가 안 보인다.

## 6. 체크리스트 (게임 담당)

- [ ] 차 화면 HTML에 `/zride-car.js`를 게임 스크립트보다 먼저 넣었다
- [ ] `?mockcar`로 P↔D를 바꿔도 화면 가림·복귀가 자연스럽다
- [ ] 실내 연출은 `car.setCabin`/`car.pulse`로만 요청하고, 게임 끝에 `car.reset()`을 부른다
- [ ] 폰은 브라우저만으로 참가된다(QR → 이름)
- [ ] 서버 주소·포트를 알려 줘서 `games.json`에 등록했다

## 서버 계약과의 관계

Z-RIDE 메인 서버(`server/`)의 `vehicle.effect.*`(AMBIENT·AIRFLOW·AUDIO, DANGER·HIT·ESCAPE)와 `vehicle.cabin.report`는 그대로 두었다. 이 브리지는 각 게임 페이지가 허브 앱에 직접 요청하는 로컬 창구다. 메인 서버의 효과 의도를 허브가 직접 실행하도록 잇는 일은 서버 담당과 따로 정한다.
