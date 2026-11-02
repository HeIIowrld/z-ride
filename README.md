# Z-RIDE — 서버 API·통신·인프라

revision 9: [범용 미션·이벤트 회차·결과·보상·재생성](server/docs/events-results-rewards.md).

revision 8: [파티 공동 수집·5분 리스폰](server/docs/collection-respawn.md) · [도메인 연결 인계](server/docs/domain-handoff.md) · [부하 검증](server/docs/load-validation-20261102.md).

[![Server CI](https://github.com/HeIIowrld/z-ride/actions/workflows/server-ci.yml/badge.svg)](https://github.com/HeIIowrld/z-ride/actions/workflows/server-ci.yml)

이 리포의 우선 작업 범위는 서버 API·차량/폰 통신·인프라다. 앱 팀은 지도·GPS/차량 SDK·화면·게임 연출을 맡는다. `android/`는 실제 통신을 검증한 참조 클라이언트로 보존한다. 담당 경계와 변경 절차는 [CONTRIBUTING.md](CONTRIBUTING.md)를 따른다.

## 서버 시작

Node.js 22.13 이상에서:

```sh
cd server
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm start
```

기본 서버는 `http://127.0.0.1:8000`, 상태 확인은 `/healthz`다. 두 Android AVD는 `http://10.0.2.2:8000`을 사용한다.

| 작업 기준 | 문서 |
| --- | --- |
| REST 36개·타입·요청/응답·오류 | [OpenAPI 3.1](server/openapi.json) |
| WS 메시지·승인·역할·재접속 | [앱 팀 연동 계약](server/docs/client-handoff.md), [protocol.json](server/protocol.json) |
| 지도 데이터·위치·수집 판정 | [world API 결정 기록](server/docs/ADR-003-phone-world.md) |
| Docker·접속 주소·운영 한계 | [인프라 인계서](server/docs/infra-runbook.md) |
| 연결 유지·EOF 조사 | [연결 감사](server/docs/connection-audit.md) |
| 4D 가상 속도·장면 효과·차량 실행 보고 | [차량 효과 API](server/docs/vehicle-effects.md) |
| 협동 임무·목표·입력·차량 관측 상태 | [서버 상태 계약](server/docs/server-state.md) |
| 원본 장소·접근성·경로 조회·QR·파티 lifecycle·거점 공유 | [장소·파티 계약](server/docs/places-parties.md) |

GitHub Actions는 서버·계약 테스트, Docker/Compose의 정상 재시작·강제 종료·볼륨 복구를 검증한다. 공개 저장소의 PR은 GitHub-hosted runner에서만 실행한다. Proxmox LXC는 별도 pull timer로 같은 리포의 main CI 성공 SHA만 가져와 서비스를 갱신한다. DB는 배포 디렉터리와 분리된 SQLite 파일에 두며 방·참가 승인·재고·중복 지급 원장이 재시작 뒤에도 유지된다. [영속성 설계](server/docs/persistence.md), [실제 배포 절차](server/docs/deployment.md)를 따른다.

팀 테스트 서버는 `http://afsd.iptime.org:8000`이다. 아이폰·Android·PC에서 `/play`를 열어 설치 없이 PHONE 역할로 참가하고 `/observer`에서 관제한다. 세션 생성에는 별도 전달받은 테스트 접근키가 필요하고 관제는 다른 읽기 전용 관찰키를 쓴다. 키·토큰·참가 코드를 공개 이슈나 URL에 적지 않는다. 현재 HTTP에서는 실제 위치 대신 데모 수집으로 통신을 시험한다. Safari의 실제 위치 사용은 HTTPS 배포가 필요하며 실물 아이폰 검증은 별도다.

## 실시간 관제

revision 6는 서버가 협동 임무·단계·목표·역할·가상 주행을 판정하고 차량의 공조·벨트·SOC 관측값을 관리한다. `heist-demo-v1`은 준비 → 잠입 → 방어 → 탈출 예시이며 좀비는 방어 단계의 한 미니게임이다. 임무·재고는 DB에 보존하고 주행 입력·센서 신선도·물리 효과 권한은 재시작 시 초기화한다. 관제에 임무 진행과 차량 관측 품질을 표시한다. [서버 상태 계약](server/docs/server-state.md)

4D 효과 세션·가상 속도에 따른 바람·위험/피격/탈출 cue·중지 API는 유지한다. 효과 의도는 차량에만 보내며 만료·주행 조건·소켓 교체·서버 재시작 뒤 재생하지 않는다. 실제 공조·조명 setter와 물리 반영/원복은 차량 앱 팀의 후속 구현이다. [연동 계약](server/docs/vehicle-effects.md)

서버의 `/observer`에서 운영자 관찰키로 방을 고르고 전체 참가자·개인별 역할 화면을 본다. 관찰키는 환경변수 `ZRIDE_OBSERVER_TOKEN`으로 설정하고 URL·소스·브라우저 저장소에 넣지 않는다. 참가자별 레이더·좀비 HP·보급품·차량 게이트를 서버 상태로 재구성한 화면이며 실제 기기의 영상 스트림은 아니다. [관제 계약](server/docs/observer.md)

실제 API를 사용하는 4인 시뮬레이션은 서버 실행 후 `node tools/demo-party.mjs --base http://127.0.0.1:8000`으로 만든다. 모든 참가자와 차량 신호는 TEST로 표시한다. [시연 도구](server/docs/demo-party.md)

Android 변경은 별도 워크플로에서 차량·폰 APK를 빌드·lint하고 artifact로 제공한다. 실제 폰·차량의 자동 설치나 스토어 배포는 포함하지 않는다.

2026-11-01. Pleos API34 차량 앱, Android 폰 앱, 로컬 게임 서버를 연결하는 개발용 프로젝트다. 상용 서비스·실차 인증·완성된 3D 좀비게임이 아니다.

## 게임 구조

- 이동 중: 승인된 동승자가 폰 자체 위치로 주변 게임 지점을 수집한다. v0.3.0은 MapLibre Native 12.3.1 OpenGL·OpenFreeMap 서울 실지도, Android LocationManager, 인증된 nearby/claim API를 연결했다. 고정 버튼 DEMO_PICKUP과 지도 좌표 검사 경로를 구분한다.
- 거점 주차·충전 중: 차량 화면은 관제·지원, 폰은 좌석별 사격을 맡는다. 모은 자원을 공동 전투에 연결한다.
- 출발: 차량 게임 UI·입력·오디오와 공동 전투는 중지한다. 폰의 독립 수집은 별도 모드다.

## 구성

| 디렉터리 | 내용 |
| --- | --- |
| `server` | 표준 HTTP/WebSocket 서버, 역할·각도·게이트·명령 중복 판정·통합시험 |
| `android` | Java native 차량/폰 앱·공유 통신·Canvas·진단·오디오 |
| `tools` | 로컬 개발 도구와 설치·실행 로그. SDK·이미지는 소스 재배포 대상이 아님 |
| `evidence` | 에뮬레이터 실행 로그·스크린샷·통합 검증 기록 |

현재 서버 계약은 [server/protocol.json](server/protocol.json), 지도 위치 계약은 [ADR-003](server/docs/ADR-003-phone-world.md), 실행·제한은 [서버 README](server/README.md), 앱 빌드는 [Android README](android/README.md)를 본다. 이전 설계의 HTTP 17개 전체를 구현한 서버는 아니다.

## 좌석과 조작

0°는 차량 전방, +90°는 우측, -90°는 좌측, ±180°는 후방이다. 실제 좌석 센서는 사람이 어느 폰을 들었는지 식별하지 않으므로 최초 매칭은 호스트 승인을 사용한다.

| 역할 | 현재 기본 행동 |
| --- | --- |
| CAR_HOST·운전자 | 시작/중지·동승자 승인·지원 펄스. 일반 사격 불가 |
| FRONT_PASSENGER | -45°~+90° 사격 |
| REAR_LEFT | -180°~-45° 사격, 센서·정비 역할 확장 후보 |
| REAR_RIGHT | +45°~+180° 사격, 후방 방어 역할 확장 후보 |

좌석 범위는 게임 규칙이며 실제 총기·차량 창문의 물리 시야 모델은 아니다. EMPTY를 관측하면 해당 폰의 사격을 차단하고, UNKNOWN을 실제 착석 증명으로 표시하지 않는다.

## 실행 방식

차량·폰 AVD는 화면 없이 `-no-window -no-snapshot`으로 부팅해 ADB와 테스트 Intent로 시험할 수 있다. 설치 후 신호 테스트에 데스크톱 클릭은 필요 없다. SDK의 실제 기본 명령은 설치·검증 보고서에 기록한다.

로컬 서버는 기본 `127.0.0.1:8000`, AVD 앱은 호스트 별칭 `http://10.0.2.2:8000`을 사용한다. CLI 기본 DB는 `data/zride.sqlite`, 배포 환경은 `/var/lib/zride/zride.sqlite`다. 외부 팀 테스트에는 `ZRIDE_TEST_ACCESS_KEY`를 설정한다. HTTPS/WSS·차량 등록 신뢰는 실제 위치·상용 환경의 추가 과제다. 게스트 토큰은 기존 8시간 만료 정책을 유지하므로 영속 저장이 무기한 로그인이나 계정 복구를 뜻하지 않는다.

## 차량 신호·권한

실제 AVD에서 조회·콜백·미지원·미허용을 구분한다. CarUxRestrictions·P 조건이 공동 전투의 허용 조건이며, 케이블 연결이나 충전 스위치만으로 실제 충전 중을 추정하지 않는다. 충전 정보의 별도 권한은 선택 버튼에서 요청하며 기본 착석·주차·통신 시험을 막지 않는다.

공조·벨트·문·창·조명 후보는 capability와 읽기 진단부터 확인한다. 게임용 음향은 AudioFocus·USAGE_GAME을 따르며 개별 실제 좌석 스피커 제어는 확인되지 않았다. 서버는 4D 효과 의도와 차량 실행 보고를 처리하며, 실제 차량 설정의 자동 변경·원복은 차량 앱에서 구현해야 한다.

## 검증 범위

서버 단독 3개 시험, APK 조립·lint, 실제 Pleos/폰 AVD 공동 전투 20개·지도 통합 8개 항목을 통과했다. 지도 검증은 에뮬레이터 GPS → 실제 Android Location callback → D 상태 claim → 차량 WS 재고 갱신·중복/거리 거부까지 포함한다. 원시 좌표를 직접 우리 앱에 넣어 성공 처리한 것이 아니다.

외부 충전소 실시간 API, 실차, 실물 폰·현장 GPS, 실제 충전 전환, 영속 보상은 별도의 검증이다. 에뮬레이터 위치는 `MOCK_DEMO`, `hardwareAttested=false`다. 현재 서울 시청의 3개 게임 지점은 실제 충전소가 아니다. 동승자 역할 매칭도 실제 운전자 신원을 자동 인증하지 않는다.

## 지도·게임 서버 연결

폰이 지도 타일을 OpenFreeMap에서 직접 받고, 서버는 게임 포인트와 획득·재고만 관리한다. `POST /api/world/nearby`는 주변 목록, `/location`은 선택적 품질 확인, `/claim`은 위치·80m·정확도 50m·나이 10초·중복 검사다. 원시 폰 위치를 차량/다른 폰의 snapshot에 전파하지 않는다. 최신 재고는 WS snapshot이 기준이고 claim 재전송 영수증은 획득 당시 기록이다.

화면 활성 중 위치 요청은 최소 2초·이동거리 0m, 주변 조회는 최소 5초·500m다. 화면을 끈 뒤 위치 수집하는 foreground service는 구현하지 않았다. 배포 시 출처 표시·서비스 조건·위치 고지/동의·보존 정책을 별도로 확인한다.

## 재검증·공유 묶음

`tools/verify-demo.py`로 새 방과 승인된 폰을 만든 뒤 `tools/verify-phone-map.py`를 실행한다. 모두 headless ADB와 공식 Console을 사용한다. `tools/package-demo.py`는 소스·APKs·정제한 증거만 묶으며 Android Studio/SDK/AVD·JDK·다운로드·토큰·캐시는 제외한다.
