# Proxmox Pleos AVD와 차량별 실제 화면

2026-11-04 Asia/Seoul. API 서버 CT315와 별도로 **CT317 (192.168.0.221)** 에 공식 Pleos Connect 2.1.0/API34 이미지를 설치하고 KVM으로 실행한다. 공식 Android Emulator stable 37.2.13/SwiftShader, Xvfb, x11vnc, websockify, noVNC를 사용한다. 브라우저 목업이나 저장된 동영상을 실제 차량 화면으로 표시하지 않는다.

| 주소 | 역할 |
| --- | --- |
| https://hyundai.hjpark.net/vehicles/ | 차량별 실행·부팅·중지와 최신 서버 연결 상태 |
| https://hyundai.hjpark.net/vehicles/1 | 실제 Pleos 1 화면·클릭·드래그·스크롤 |
| https://hyundai.hjpark.net/vehicles/2 | 실제 Pleos 2, 별도 파티 |
| https://hyundai.hjpark.net/vehicles/3 | 실제 Pleos 3, 별도 파티 |
| /vehicles/status.json | 별도 viewer 서비스의 공개 상태 요약. 게임 REST 55개와 별도 운영 경로 |

## 용량과 실행 범위

호스트는 RAM 약 30GiB/16스레드이며 기존 VM·컨테이너들이 실행 중이다. 설치 시작 시 가용 RAM 약 7GiB, 스왑 대부분 사용 중이었다. Pleos 한 대는 4GiB RAM 설정으로 실제 부팅했지만 이후 컨테이너 메모리 제한에 도달해 종료됐다. 다른 VM을 중지하거나 줄이지 않았다.

현재 세 대는 각각 **RAM 3GiB/1600×900/2 vCPU의 제한된 데모 프로필**이다. 공식 RAM4GiB·권장 GPU 사양과 다르므로 표준 성능 검증 결과로 간주하지 않는다. 사용자가 다른 VM을 종료한 뒤 가용 메모리 약13GiB를 확인하고 2·3번도 부팅했다. 첫 부팅 중 기존 MemoryMax5800M에 걸린 2번은 한도를 조정해 재기동했다. 실제 최종 가동 상태와 메모리 수치는 별도 검증 기록에 남긴다.

CT317: RAM 제한20GiB, 8 CPU, rootfs64GiB. AVD 서비스는 MemoryMax7500M/MemorySwapMax128M/CPUQuota300%로 제한하며 자동 재시작하지 않는다. 호스트 capacity guard는 MemAvailable1GiB 미만 또는 메모리 PSI avg10>20일 때 CT317의 에뮬레이터만 중지한다. 기존 API·다른 VM은 중지하지 않는다. 재부팅 뒤 에뮬레이터는 운영자가 자원을 확인해 시작한다.

## 실제 차량 앱과 통신

참조 APK `ai.zride.demo.car`가 실제 AAOS CarPropertyManager/CarUxRestrictions와 Pleos Vehicle SDK를 읽고 공용 서버에 CAR_HOST/WS로 연결한다. 실제 부팅 후 gear=P, UX=ALLOWED, 충전 상태·Pleos SOC 읽기를 확인했다. SDK 착석 Boolean 의미는 기존대로 미검증이므로 점유를 확정하지 않는다.

차량 앱의 폰 초대 QR은 기존 party/invite API를 호출한다. 120초·최대3회 초대 URL만 표시하고 HOST/개인 토큰을 QR이나 로그에 넣지 않는다. QR 발급은 로컬 UX/foreground 허용 때만 가능하고 주행 제한 때 숨긴다. 한 번 QR을 발급한 동일 방에서 주차·foreground가 유지되면 만료 시 자동 갱신한다. 폰은 같은 Google/게스트·계정 초대 API를 사용하며 실제 차량 앱의 승인 목록에 나타난다. 실제 센서가 달린 전기차를 검증한 것은 아니다.

상태 서비스는 Android의 **현재 사용자**를 확인한 뒤 디버그 앱 private room-state.json 중 최신 10초 이내의 roomId/기어/UX/인원만 공개한다. Android Automotive의 사용자10과 사용자0을 혼동하지 않는다. 오래된 파일로 파티가 연결됐다고 표시하지 않으며 참가 코드·토큰·원시 좌표·멤버 상세는 상태 JSON에서 제외한다.

## 공개 범위

사용자 요청에 따라 웹에서 세 차량의 마우스·키보드 입력을 허용했다. 같은 차량 페이지를 여럿 열면 동일한 실제 화면과 입력을 공유한다. 별도 차량 접근키 없이 팀 테스트가 가능하다. 게임 로그인·초대·차량 승인 권한은 기존 서버 계약을 유지한다. raw VNC는 CT317 loopback이며 ADB/콘솔 포트는 인터넷으로 포워딩하지 않는다. 공개 화면은 hyundai vhost에만 연결하고 클립보드 동기화는 끈다. 공개 HTTP에는 임의 ADB·일반 명령·파일 읽기·에뮬레이터 기동/중지 API가 없다.

`/vehicles/console/1/`~`3/`는 각 AVD의 **공식 Pleos Connect Virtual Console**이다. `adb forward tcp:8081..8083 tcp:8088`를 내부에서 유지하고 socat의 고정8181..8183을 nginx로 연결한다. 하위경로 프록시는 vendor/vehicle/glb/hdri/browser/highway 자원 경로를 차량별로 재작성한다. 외부로 ADB를 공개하지 않는다. 공식 콘솔의 기어·속도·공조·벨트/착석 시뮬레이션은 이 가상 차량에만 적용된다. 공식 콘솔과 자동 이동을 동시에 조작하지 않는다. 사용자 계정이 로그인된 개인 용도로 에뮬레이터를 사용하지 않는다.

## 이동·경로 변경 시험

차량 페이지의 ‘이동·경로 변경 시뮬레이션’을 펼쳐 목적지A/B → 목적지 설정 → 서버 APPLIED 확인 → 이동 시작 → 다른 목적지 선택·경로 변경 → 주차 또는 안내 취소 순으로 시험한다. 10/30/60km/h와 시간1/5/10배를 선택한다. D·UX 제한에서는 차량 게임/QR을 숨기며, 주차 P로 복귀해야 협동 게임과 승인을 진행한다. 폰 수집은 승인된 동승자의 기존 계정·월드 API를 사용한다.

운영용 `GET/POST /vehicles/simulation/{1|2|3}`는 고정 동작만 받는다. POST는 같은 Origin과 JSON, expectedRevision 일치가 필요하다. 액션: destination/reroute/start/pause/park/cancel. 좌표·URL·ADB 문자열을 임의로 입력받지 않는다. 차량별 잠금과 revision으로 중복·동시 조작 충돌을 구분한다. 오류 시 이동을 중단하고 P 복귀를 시도한다. 서비스 재시작 때 시뮬레이터 상태는 초기화되며 자동 이동을 재개하지 않는다.

GPS는 Android Emulator geo fix로 넣고 기어·속도는 공식 Virtual Console에 반영한다. 디버그 차량 APK의 private `demo-route.json` bridge는 자신의 메모리 내 HOST 인증으로 기존 POST /api/rooms/{id}/route를 호출한다. 결과 영수증이 확인되기 전에는 이동을 시작하지 않는다. 서버 경로 변경은 승인된 폰의 snapshot.party.route revision/source/active로 즉시 전달하며 실제 경로 geometry는 방송하지 않는다. 폰은 revision 변경 후 기존 route/spots를 재조회한다. 경로 변경은 현재 위치에서 출발하며 도착 시 자동 P, 취소는 source=NONE으로 서버 경로를 비운다.

**두 경로는 여의도 일대 합성 시험 좌표이며 도로망·통행 가능성을 검증한 길찾기 결과가 아니다.** 출처는 DEMO_ROUTE다. 내장 내비 앱에 실제 목적지를 입력하거나 Pleos Navigation SDK의 길찾기·재탐색 callback을 연결한 결과가 아니며, 실제 SDK callback 연동은 팀 차량 앱 구현에서 이 기존 route API로 교체한다. 에뮬레이터 GPS를 바꿔도 실물 폰의 GPS나 아이템 획득 위치 증명은 바꾸지 않는다. GPS 이동만으로 아이템/보상이 자동 지급되지 않는다.

SDK 이미지·실행 파일·AVD 사용자 데이터·APK·개인 키는 저장소와 공개 정적 디렉토리에 넣지 않는다. viewer 파일만 별도 서비스에 설치한다. 기존 API CI와 Android APK 빌드/lint를 유지하며 에뮬레이터 APK 자동 설치는 별도 운영 작업이다.

## 운영

PVE에서 `pct exec 317 -- systemctl start pleos-vehicle@1` / `stop pleos-vehicle@1`로 각 대를 관리한다. 상태/로그는 CT317의 `pleos-viewer.service`, `pleos-vehicle@1.service`, `/home/emulator/logs/`에서 확인한다. SDK는 /opt/android-sdk, AVD는 /home/emulator/.android/avd에 있다. 서비스를 추가로 시작하기 전에 실제 호스트 메모리를 확인한다.

소스: deploy/pleos-viewer. 같은 디렉토리의 unittest는 사용자10/최신성/비공개 값 제외/경로 탈출/제어 API 부재를 검사한다. 실제 기동·SDK 신호·WSS 화면은 별도로 확인한다.

[Pleos 설치·실행](https://document.pleos.ai/en/docs/connect/guide/getting-started/application-development/setup-connect-sdk-emulator) · [Pleos AVD 구성/GPU](https://document.pleos.ai/en/docs/connect/guide/getting-started/application-development/configure-pleos-connect-emulator) · [Pleos 앱 시작/RAM4GiB](https://document.pleos.ai/en/docs/pleos-only/getting-started) · [Android Linux KVM](https://developer.android.com/studio/run/emulator-acceleration).


웹 승인의 터치가 vehicle.report에 의해 취소되지 않도록 Android 승인 버튼은 대기 목록이 달라질 때만 다시 만든다. 공식 Virtual Console은 세션 heartbeat가 살아 있을 때만 쓰기를 허용하므로 이동 worker도 정해진 client ID의 세션을 갱신한다.

[공식 Virtual Console 설치](https://document.pleos.ai/en/docs/connect/guide/getting-started/application-development/use-vehicle-emulator) · [공식 기능 범위](https://document.pleos.ai/en/docs/pleos-only/app-test-guide/virtual-console-guide) · [noVNC 입력/화면 API](https://novnc.com/noVNC/docs/API.html).
