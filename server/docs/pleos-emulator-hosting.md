# Proxmox Pleos AVD와 차량별 실제 화면

2026-11-04 Asia/Seoul. API 서버 CT315와 별도로 **CT317 (192.168.0.221)** 에 공식 Pleos Connect 2.1.0/API34 이미지를 설치하고 KVM으로 실행한다. 공식 Android Emulator stable 37.2.13/SwiftShader, Xvfb, x11vnc, websockify, noVNC를 사용한다. 브라우저 목업이나 저장된 동영상을 실제 차량 화면으로 표시하지 않는다.

| 주소 | 역할 |
| --- | --- |
| https://hyundai.hjpark.net/vehicles/ | 차량별 실행·부팅·중지와 최신 서버 연결 상태 |
| https://hyundai.hjpark.net/vehicles/1 | 실제 Pleos 1 화면·클릭·드래그·스크롤 |
| https://hyundai.hjpark.net/vehicles/2 | 실제 Pleos 2, 별도 파티 |
| https://hyundai.hjpark.net/vehicles/3 | 실제 Pleos 3, 별도 파티 |
| https://hyundai.hjpark.net/vehicles/phone | 실제 Android 14 동승자 에뮬레이터. Chrome의 PLY를 웹에서 조작 |
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

차량 앱에서 여정을 시작해 동승자 QR을 발급한 다음, [Pleos 1](https://hyundai.hjpark.net/vehicles/1)의 **여정 시나리오**를 펼친다. 여의도 동·서쪽, 짧은 보급품 시연, 직접 설정 중에서 고른다. 직접 설정은 위도, 경도 순의 출발점과 도착점을 직선으로 잇는다. **경로 적용** 후 **시작**을 누른다. 10/30/60km/h와 1/2/5/10배속을 선택할 수 있다. 배속은 위치 진행에 적용되며 표시 차량 속도는 그대로다. 중간 위치로 이동하면 P에 정차하고, 시작을 누르면 그 위치에서 재개한다.

**시나리오 링크 복사**로 프리셋 또는 직접 입력한 좌표, 차량 속도, 배속을 공유한다. 링크를 열면 설정만 채운다. 실제 재생은 진행자가 누른다. 같은 차량 화면과 재생 상태는 팀원이 함께 볼 수 있다. 실제 폰은 차량 QR로 참가한다. [공유 Android](https://hyundai.hjpark.net/vehicles/phone)에서는 QR에서 복사한 초대 링크를 넣고 **Android에서 열기**를 누른다. Android Chrome에서 게스트로 좌석을 신청하고 차량에서 승인한다. D·UX 제한에서는 차량 게임과 QR을 숨기고 주차 P에서 다시 표시한다.

운영용 `GET/POST /vehicles/simulation/{1|2|3}`는 고정 동작만 받는다. POST는 같은 Origin과 JSON, expectedRevision 일치가 필요하다. 액션은 destination/reroute/start/pause/park/cancel/seek다. 직접 설정은 위경도 숫자 두 쌍을 받고, seek는 0부터 1까지의 진행률을 받는다. 차량별 잠금과 revision으로 중복·동시 조작 충돌을 구분한다. 오류 시 이동을 중단하고 P 복귀를 시도한다. 서비스 재시작 때 시뮬레이터 상태는 초기화되며 자동 이동을 재개하지 않는다.

GPS는 Android Emulator geo fix 또는 Pleos AVD의 Android 테스트 위치 공급자로 넣고, 기어·속도는 공식 Virtual Console에 반영한다. 테스트 위치 공급자는 여정 종료와 viewer 종료 때 해제한다. 디버그 차량 APK의 private `demo-route.json` bridge는 자신의 메모리 내 HOST 인증으로 기존 POST /api/rooms/{id}/route를 호출한다. 결과 영수증이 확인되기 전에는 이동을 시작하지 않는다. 서버 경로 변경은 승인된 폰의 snapshot.party.route revision/source/active로 즉시 전달하며 실제 경로 geometry는 방송하지 않는다. 폰은 revision 변경 후 기존 route/spots를 재조회한다. 경로 변경은 현재 위치에서 출발하며 도착 시 자동 P, 취소는 source=NONE으로 서버 경로를 비운다.

**두 경로는 여의도 일대 합성 시험 좌표이며 도로망·통행 가능성을 검증한 길찾기 결과가 아니다.** 출처는 DEMO_ROUTE다. 내장 내비 앱에 실제 목적지를 입력하거나 Pleos Navigation SDK의 길찾기·재탐색 callback을 연결한 결과가 아니며, 실제 SDK callback 연동은 팀 차량 앱 구현에서 이 기존 route API로 교체한다. 에뮬레이터 GPS를 바꿔도 실물 폰의 GPS나 아이템 획득 위치 증명은 바꾸지 않는다. GPS 이동만으로 아이템/보상이 자동 지급되지 않는다.

SDK 이미지·실행 파일·AVD 사용자 데이터·APK·개인 키는 저장소와 공개 정적 디렉토리에 넣지 않는다. viewer 파일만 별도 서비스에 설치한다. 기존 API CI와 Android APK 빌드/lint를 유지하며 에뮬레이터 APK 자동 설치는 별도 운영 작업이다.

## 운영

PVE에서 `pct exec 317 -- systemctl start pleos-vehicle@1` / `stop pleos-vehicle@1`로 각 대를 관리한다. 상태/로그는 CT317의 `pleos-viewer.service`, `pleos-vehicle@1.service`, `/home/emulator/logs/`에서 확인한다. SDK는 /opt/android-sdk, AVD는 /home/emulator/.android/avd에 있다. 서비스를 추가로 시작하기 전에 실제 호스트 메모리를 확인한다.

소스: deploy/pleos-viewer. 같은 디렉토리의 unittest는 사용자10/최신성/비공개 값 제외/경로 탈출/제어 API 부재를 검사한다. 실제 기동·SDK 신호·WSS 화면은 별도로 확인한다.

공유 Android는 CT317의 별도 `PLY_Phone` AVD와 `ply-phone.service`를 사용한다. 2GiB RAM·x86_64 Google APIs API 34 시스템 이미지에서 Chrome을 실행한다. 설치 파일은 `start-phone.sh`, `ply-phone.service`다. 기존 Pleos 화면과 같은 noVNC 프록시를 쓰고, Android의 초대 입력은 운영 PLY QR 형식만 받는다.

[Pleos 설치·실행](https://document.pleos.ai/en/docs/connect/guide/getting-started/application-development/setup-connect-sdk-emulator) · [Pleos AVD 구성/GPU](https://document.pleos.ai/en/docs/connect/guide/getting-started/application-development/configure-pleos-connect-emulator) · [Pleos 앱 시작/RAM4GiB](https://document.pleos.ai/en/docs/pleos-only/getting-started) · [Android Linux KVM](https://developer.android.com/studio/run/emulator-acceleration).


웹 승인의 터치가 vehicle.report에 의해 취소되지 않도록 Android 승인 버튼은 대기 목록이 달라질 때만 다시 만든다. 공식 Virtual Console은 세션 heartbeat가 살아 있을 때만 쓰기를 허용하므로 이동 worker도 정해진 client ID의 세션을 갱신한다.

[공식 Virtual Console 설치](https://document.pleos.ai/en/docs/connect/guide/getting-started/application-development/use-vehicle-emulator) · [공식 기능 범위](https://document.pleos.ai/en/docs/pleos-only/app-test-guide/virtual-console-guide) · [noVNC 입력/화면 API](https://novnc.com/noVNC/docs/API.html).

## 다중 AVD 그래픽 오류 대응

세 AVD 동시 시험 중 1번 SIGSEGV와 2·3번 종료가 발생했다. OOM/호스트 guard 종료가 아닌 graphics/ColorBuffer 오류가 기록됐으며 원인 확정이나 장시간 안정성 검증은 별도다. Android 공식 문제 해결 지침에 따라 SwiftShader와 `-feature -Vulkan`을 함께 사용하고 AVD 기본 LCD도1600×900으로 맞춰 다시 시험한다. 메모리 여유만으로 세 대 장시간 실행을 보장하지 않는다. [Android Emulator 공식 문제 해결](https://developer.android.com/studio/run/emulator-troubleshooting).

Vulkan만 끈 재시험에서도 동시 종료가 재발했다. 이후 ANGLE/SwiftShader인 `swangle`에서 단일 AVD의60km/h·10배속1624m 이동 → 자동 ARRIVED/P → 안내 취소/NONE 서버 영수증은 통과했지만, 이어진 시험에서 기본 DrivingView의 libUnreal.so 반복 종료와 앱 화면 이탈이 확인됐다. 이를 안정화 완료로 간주하지 않는다. DrivingView 비활성 시험은 기본 화면 배치에 영향을 줘 원복했다. `host` 모드도 현재 Xvfb에서는 실제 AMD GPU 대신 llvmpipe/GLES3.0을 선택했다.

따라서 마지막 운영 기본값은 **1대·RAM4GiB·SwiftShader**로 되돌리고 2·3번은 장시간 동시 실행이 검증될 때까지 중지한다. `PLEOS_GPU_MODE=swiftshader|swangle|host`, `PLEOS_RAM_MB=4096|3072`를 운영자가 선택할 수 있다. RAM4GiB는 공식 RAM 안내와 맞지만 GPU 환경은 여전히 다르다.1번의 운영 drop-in은 MemoryMax10000M/CPUQuota500%다. 실제 상태는 목록에서 확인한다. [Android 공식 렌더링 모드](https://developer.android.com/studio/run/emulator-acceleration).
