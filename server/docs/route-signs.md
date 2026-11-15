# 경로 표지판 · 내비 스타일 여행 지도

동승자 폰의 여행 지도에 차량 위치, 출발지에서 목적지까지의 경로선, 경로 위의 랜덤 표지판을 표시한다. 차량이 표지판 근처를 지나면 동승자가 표지판을 눌러 주행 게임(운전면허 퀴즈·폴짝 전봇대·빗방울 캐치) 중 하나를 골라 플레이하고, 서버가 판정해 크루 가방에 공통 아이템 1개를 넣는다.

## 경로선 출처

Pleos NaviHelper 3.0.5는 도로 폴리라인을 주지 않는다([native-navigation.md](native-navigation.md)). 그래서 경로선은 아래 순서로 정한다.

| 우선순위 | 조건 | source |
| --- | --- | --- |
| 1 | `/api/rooms/{roomId}/route`로 등록한 경로(DEMO_ROUTE·EXTERNAL_ROUTING·PLEOS_ROUTE)가 유효함 | 등록 source |
| 2 | 내비 보고에 현재 위치 + 목적지 좌표가 있고 상태가 ROUTE_READY·ROUTE_DRIVE·ARRIVED | `EXTERNAL_ROUTING_OSRM` |
| 3 | 2에서 길찾기 실패 | `STRAIGHT_LINE_FALLBACK`(출발→도착 직선, 폰에 안내 문구 표시) |

- 차량 앱은 `onDestinationInfo`의 목적지 좌표를 `destinationLatitude`·`destinationLongitude`로 보고한다. (0,0)은 목적지 없음으로 무시한다.
- 길찾기는 경로 key(`nativeRouteRevision` + 목적지 + 이탈 재탐색 횟수)가 바뀔 때만 1회 호출한다. 같은 경로를 주행하는 동안 다시 호출하지 않는다.
- **재탐색**: 주행 중 목적지를 바꾸거나 Pleos가 경로를 다시 계산하면(revision 증가), 또는 외부 길찾기 경로에서 150m 넘게 8초 이상 벗어나면 현재 위치에서 새 경로를 받아 표지판을 새로 배치한다. 새 경로를 받는 동안에는 기존 경로·표지판을 그대로 보여주고 `journeyRoute.rerouting=true`로 알린다.
- 길찾기 주소는 `ZRIDE_ROUTING_URL`(OSRM 호환)이다. 기본값은 OSRM 공개 데모 서버(`https://router.project-osrm.org`)이며 데모·개발 용도로만 쓴다. 운영 시 자체 OSRM을 띄우거나 `off`로 끈다. 테스트용 `createDemoServer()`는 기본으로 길찾기를 하지 않는다.
- 경로선은 폰 지도·표지판 배치용 추정치이며, 공인 Pleos 도로 형상이 아니다.

## 표지판 배치와 상태

- 경로를 따라 2~3.2km 간격으로 랜덤 배치한다(10km에 3~4개, 출발·도착 400m 이내 제외, 최대 12개). 시드는 `roomId + 경로 key`라서 같은 크루는 같은 위치를 보고, 새 경로면 새 배치가 된다.
- 차량 위치를 경로에 투영해 `progressM`(진행 거리)을 갱신한다. 경로에서 300m 넘게 벗어나면 진행 거리를 멈춘다.

| state | 의미 |
| --- | --- |
| `AHEAD` | 앞쪽 표지판. 지도에 표시만 됨 |
| `READY` | 차량이 500m 안에 있음(경로상 거리도 1km 이내). 지나친 뒤에는 경로상 500m·30초 이내까지 유지. 게임 시작 가능 |
| `CLAIMED` | 이 동승자가 이미 보상을 받음 |
| `MISSED` | 지나쳤고 유예 시간이 끝남 |

## API

`POST /api/world/route-sign`(승인된 동승자, 좌석 EMPTY 아님, 운전자 불가)

1. 시작 `{signId, gameId}` → `{challengeId, gameId, expiresAt, minPlayMs}`. 표지판이 READY여야 한다.
2. 완료 `{challengeId, result:{score}}` → `{items, supplies, inventory}`. 시작 후 5초 이상, 5분 이내여야 한다. 동승자마다 표지판당 1회 지급한다.

보상은 `minigames/data/loot_tables.json`의 `common` 표에서 가중치로 추첨한다(게임별 선호 3배 가중은 기존 loot-engine과 같다). `supply`는 파티 보급품 카운터로 들어간다. 스냅샷의 `journeyRoute`·`routeSignHistory` 필드는 [protocol.json](../protocol.json)을 본다.

## 폰 화면

- 지도는 **진행 방향이 항상 위**다. 차량 화살표는 화면 아래쪽(높이 75%)에 고정되고 지도가 회전·이동한다. Leaflet은 회전을 지원하지 않으므로 지도를 프레임 대각선 크기의 정사각형에 그리고 CSS로 회전하며, 표지판·도착·장소 핀은 반대로 회전해 똑바로 선다. 드래그는 회전량을 보정해 손가락 방향대로 움직인다.
- 위치 보고(1~3초 간격) 사이에는 차량 위치와 방향을 보간해 부드럽게 움직인다.
- 지도를 손으로 움직이면 따라가기·회전이 멈추고 왼쪽 아래에 검정·흰색 `현재 위치` 버튼이 뜬다. 누르거나 15초가 지나면 다시 따라간다.
- 안내 상자에는 `목적지까지 남은 거리·시간`과 다음 표지판 안내를 표시한다. 표지판 위에는 글자 라벨을 표시하지 않는다(지나친 표지판은 흐리게, 받은 표지판은 회색). 표지판 패널은 상태 제목과 `경로 표지판 1 / 4`(순번 / 전체)를 표시한다.
- 게임 iframe은 끝날 때 `zride:drive-result`를 부모에 보낸다. 표지판 도전 중이면 앱이 서버에 완료를 보내고 `zride:drive-reward`로 결과를 돌려준다. 도전 중이 아니면 기존 로컬 보상으로 동작한다.

## 아이콘 교체

`server/phone-client/route-sign/` 폴더에 새 이미지(png·svg·webp·jpg)를 넣고 [config.js](../phone-client/route-sign/config.js)의 `icon`(표지판) 또는 `destinationIcon`(도착) 값을 바꾼 뒤 서버를 다시 시작한다. 이 폴더의 파일은 서버가 `/play/route-sign/`에서 자동으로 제공하므로 다른 코드는 고칠 필요가 없다. 현재 표지판은 `sign-battery.png`, 도착은 `destination.svg`(핀 끝이 도착 지점)이다.

## 실제 Pleos 사용 흐름

1. 서버 실행 시 크루 초대 QR을 쓰려면 `ZRIDE_PUBLIC_ORIGIN`(폰이 접속할 주소)을 설정한다. 길찾기 주소는 `ZRIDE_ROUTING_URL`로 바꿀 수 있다.
2. Pleos 차량 앱(목적지 좌표를 보고하는 버전으로 다시 빌드한 APK)에서 크루 로비를 열고 동승자 폰을 승인한다.
3. Pleos 내비에서 목적지를 정하고 안내를 시작한다. 차량 앱이 현재 위치·목적지 좌표를 보고하면 서버가 경로를 받아오고, 폰 지도에 경로선과 표지판이 표시된다.
4. 차량이 표지판 500m 안에 들어오면 폰에서 표지판을 눌러 게임을 고른다. 게임을 마치면 크루 가방에 아이템이 들어간다.
5. 주행 중 목적지를 바꾸거나 Pleos가 재탐색하면 새 경로와 표지판으로 바뀐다.

에뮬레이터에서는 Android GNSS 위치를 바꿔도 순정 내비가 보고하는 위치가 고정될 수 있다([native-navigation.md](native-navigation.md)). 이때는 차량 앱이 `ANDROID_GNSS` 위치를 우선 보고하므로 GNSS 위치를 경로를 따라 바꿔 가며 시험한다.
