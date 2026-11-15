# PLY · Z-RIDE

Pleos 차량과 동승자 폰을 연결하는 게임 데모다. 차량에서 QR을 열고 동승자를 승인하면 폰에 여행 지도가 열린다. 차량이 달리는 동안 경로 표지판에서 주행 게임을 시작하고, 주차하거나 충전 거점에 도착하면 차량과 폰에서 협동 게임을 즐길 수 있다.

[![Server CI](https://github.com/HeIIowrld/z-ride/actions/workflows/server-ci.yml/badge.svg)](https://github.com/HeIIowrld/z-ride/actions/workflows/server-ci.yml)

## 데모

1. [Pleos 차량 화면](https://hyundai.hjpark.net/vehicles/)에서 PLY 크루 로비를 열고 초대 QR을 띄운다.
2. 실제 폰으로 QR을 스캔하거나 차량 화면에서 **차량 QR을 Android에서 열기**를 눌러 공유 Android로 참가한다. 차량에서 동승자를 승인한다.
3. Pleos 내비 안내를 시작하거나 차량 화면의 데모 여정을 재생한다. 폰에서 경로와 표지판을 확인한다.

[폰 참가 화면](https://hyundai.hjpark.net/play) · [공유 Android](https://hyundai.hjpark.net/vehicles/phone) · [Pleos 시연 안내](server/docs/pleos-emulator-hosting.md)

폴짝 전봇대, 빗방울 캐치, 운전면허 퀴즈는 표지판마다 하나씩 배정된다. 차량이 가까워지면 해당 게임을 열 수 있고, 점수를 얻어 마치면 전용 아이템이 크루 가방에 들어간다. 충전소·주유소·주차장 핀은 장소 카탈로그에 등록한 지점을 쓴다. 게임 표지판은 서버가 경로선 위에 배치한다. [경로 표지판과 보상](server/docs/route-signs.md) · [게임 구성](minigames/README.md)

## 로컬 실행

Node.js 22.13 이상을 사용한다.

```sh
cd server
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm start
```

PC는 `http://127.0.0.1:8000`, Android AVD는 `http://10.0.2.2:8000`으로 접속한다. 충전 게임 4종(Power Castle, Volt Rush, Power Tug, 충전 릴레이)도 이 서버가 `/charge/<게임>/`으로 직접 띄우므로 Cloudflare 없이 한 컴퓨터에서 시연할 수 있다. 동승자 페이지는 `/play`, WebSocket은 `/ws`, 상태 확인은 `/healthz`다. Docker를 쓰는 경우 `server/`에서 `docker compose up --build`를 실행한다. [서버 설정](server/README.md) · [Android 빌드](android/README.md)

## 통신과 지도

- 차량은 `vehicle.report`와 `navigation.report`로 차량 상태와 내비 정보를 보낸다. 서버가 좌석 승인과 게임 진입 조건을 확인하고, 최신 방 상태와 재고를 승인된 클라이언트에 전달한다.
- 등록 경로가 있으면 폰은 그 경로를 쓴다. Pleos 내비를 쓸 때는 서버가 차량 위치에서 유효한 경유지를 순서대로 지나 목적지까지 OSRM으로 계산한다. 좌표를 받지 못한 경유지는 여행 지도에 안내한다. [Pleos 내비 연동](server/docs/native-navigation.md)
- [장소 목록](data/places/README.md)은 차량 도로망 연결 근거로 선별한 OSM 객체 17,923개를 담고 있다. 선별 기준과 현장 확인 범위는 [차량 접근 기준](data/places/DRIVING_FILTER.md)에 정리했다.

## 소스와 계약

| 위치 | 내용 |
| --- | --- |
| [`server/`](server/README.md) | HTTP·WebSocket 서버, 폰 웹 화면, 방·차량 상태·아이템 판정 |
| [`android/`](android/README.md) | Pleos SDK·파티 연동을 검증하는 차량과 폰 앱 |
| [`minigames/`](minigames/README.md), `games/` | 주행 미니게임, 충전 게임, DEADZONE |
| [`data/places/`](data/places/README.md), `tools/` | 장소 데이터와 시연·검증 도구 |

- [REST OpenAPI](server/openapi.json) · [WebSocket 프로토콜](server/protocol.json) · [앱 팀 인계서](server/docs/client-handoff.md)
- [장소와 파티](server/docs/places-parties.md) · [폰 로그인과 QR 초대](server/docs/phone-accounts.md) · [차량 효과](server/docs/vehicle-effects.md)
- [읽기 전용 관제](server/docs/observer.md) · [SQLite 저장](server/docs/persistence.md) · [Proxmox 배포](server/docs/deployment.md)

서버 CI는 API와 게임 보상 테스트를 실행하고 Docker에서 재시작 후 상태 복원을 확인한다. 배포 서버는 `main`의 Server CI 성공 SHA를 가져온다. Android 변경은 GitHub Actions에서 APK를 빌드하고 lint를 실행한다. 브랜치와 PR 절차는 [CONTRIBUTING.md](CONTRIBUTING.md)를 따른다.
