# Z-RIDE DEADZONE

주차 중에 하는 1~4인 좀비 협동 게임이다. 폰에서 플레이하고 Pleos 화면에서 QR과 팀 상태를 본다. 퓨즈를 트렁크로 가져와 차량을 수리하거나 헤드라이트를 켜고, 세 웨이브 동안 팀 차량을 지키면 승리한다.

## 실행

Node.js 22.12 이상에서 `games/deadzone`을 기준으로 실행한다.

```sh
npm ci
npm run build
cd packages/server
WRANGLER_SEND_METRICS=false ../../node_modules/.bin/wrangler dev --local --ip 0.0.0.0 --port 8788 --config wrangler.local.toml
```

- 게임은 `http://localhost:8788/`에서 실행한다.
- 게임과 차량 화면을 함께 보려면 `http://localhost:8788/preview.html`을 연다.
- 차량 화면은 `http://localhost:8788/dashboard`에서 방을 생성하고 QR을 띄울 수 있다.
- 폰으로 QR에 참가할 때는 같은 Wi-Fi에서 서버 Mac의 LAN 주소로 대시보드를 열어 QR을 생성한다.

## Pleos

`integrations/pleos/dashboard-preview`는 Android API 34와 Java 17을 사용하는 독립 에뮬레이터 미리보기 모듈이다. 호환 Android Gradle 프로젝트에 추가한 뒤 `include(":dashboard-preview")`로 등록하고 `./gradlew :dashboard-preview:assembleDebug`로 빌드한다. 에뮬레이터의 기본 주소는 `http://10.0.2.2:8788/dashboard`다.

게임 룸은 독립 Wrangler 서버에 있고, 대시보드는 방 상태를 읽어 WebView 브리지로 전달한다. 연동 계약은 [웹앱·차량 대시보드 인계](docs/ZRIDE-HANDOFF.md)에 있다.

OVERRUN을 기반으로 수정했으며 [Apache-2.0 라이선스](LICENSE)와 [저작권 고지](NOTICE)를 포함한다.
