# Proxmox Pleos AVD와 차량별 실제 화면

2026-11-04 Asia/Seoul. API 서버 CT315와 별도로 **CT317 (192.168.0.221)** 에 공식 Pleos Connect 2.1.0/API34 이미지를 설치하고 KVM으로 실행한다. 공식 Android Emulator stable 37.2.13/SwiftShader, Xvfb, x11vnc, websockify, noVNC를 사용한다. 브라우저 목업이나 저장된 동영상을 실제 차량 화면으로 표시하지 않는다.

| 주소 | 역할 |
| --- | --- |
| https://hyundai.hjpark.net/vehicles/ | 차량별 실행·부팅·중지와 최신 서버 연결 상태 |
| https://hyundai.hjpark.net/vehicles/1 | 실제 Pleos 1 화면 읽기 전용 |
| https://hyundai.hjpark.net/vehicles/2 | 2번 자리, 현재 중지 |
| https://hyundai.hjpark.net/vehicles/3 | 3번 자리, 현재 중지 |
| /vehicles/status.json | 별도 viewer 서비스의 공개 상태 요약. 게임 REST 55개와 별도 운영 경로 |

## 용량과 실행 범위

호스트는 RAM 약 30GiB/16스레드이며 기존 VM·컨테이너들이 실행 중이다. 설치 시작 시 가용 RAM 약 7GiB, 스왑 대부분 사용 중이었다. Pleos 한 대는 4GiB RAM 설정으로 실제 부팅했지만 이후 컨테이너 메모리 제한에 도달해 종료됐다. 다른 VM을 중지하거나 줄이지 않았다.

현재 1번은 **RAM 3GiB/1600×900/2 vCPU의 제한된 데모 프로필**이다. 공식 가이드의 RAM 4GiB·권장 GPU 환경과 다르므로 표준 사양 성능 검증 결과로 간주하지 않는다. 한 대 실행도 호스트에서 대략 4.5~5GiB 이상을 소비한다. 현재 자원으로 2~3대 동시 실행을 검증하거나 보장하지 않았다. 2·3번 AVD는 준비만 하고 중지했다.

CT317: RAM 제한6GiB, 4 CPU, rootfs64GiB. AVD 서비스는 MemoryMax5800M/MemorySwapMax128M/CPUQuota300%로 제한하며 자동 재시작하지 않는다. 호스트 capacity guard는 MemAvailable1GiB 미만 또는 메모리 PSI avg10>20일 때 CT317의 에뮬레이터만 중지한다. 기존 API·다른 VM은 중지하지 않는다. 재부팅 뒤 에뮬레이터는 운영자가 자원을 확인해 시작한다.

## 실제 차량 앱과 통신

참조 APK `ai.zride.demo.car`가 실제 AAOS CarPropertyManager/CarUxRestrictions와 Pleos Vehicle SDK를 읽고 공용 서버에 CAR_HOST/WS로 연결한다. 실제 부팅 후 gear=P, UX=ALLOWED, 충전 상태·Pleos SOC 읽기를 확인했다. SDK 착석 Boolean 의미는 기존대로 미검증이므로 점유를 확정하지 않는다.

차량 앱의 폰 초대 QR은 기존 party/invite API를 호출한다. 120초·최대3회 초대 URL만 표시하고 HOST/개인 토큰을 QR이나 로그에 넣지 않는다. QR 발급은 로컬 UX/foreground 허용 때만 가능하고 주행 제한 때 숨긴다. 한 번 QR을 발급한 동일 방에서 주차·foreground가 유지되면 만료 시 자동 갱신한다. 폰은 같은 Google/게스트·계정 초대 API를 사용하며 실제 차량 앱의 승인 목록에 나타난다. 실제 센서가 달린 전기차를 검증한 것은 아니다.

상태 서비스는 Android의 **현재 사용자**를 확인한 뒤 디버그 앱 private room-state.json 중 최신 10초 이내의 roomId/기어/UX/인원만 공개한다. Android Automotive의 사용자10과 사용자0을 혼동하지 않는다. 오래된 파일로 파티가 연결됐다고 표시하지 않으며 참가 코드·토큰·원시 좌표·멤버 상세는 상태 JSON에서 제외한다.

## 공개 범위

화면 입력은 noVNC와 x11vnc 서버 양쪽에서 읽기 전용으로 제한한다. 공개 HTTP에는 ADB 실행·기동/중지·파일 읽기·일반 명령 실행 API가 없다. 운영자 입력은 내부 ADB/관리 콘솔에서 수행한다. raw VNC는 CT317 loopback, ADB/에뮬레이터 콘솔도 외부로 포워딩하지 않는다. nginx에는 hyundai 호스트의 /vehicles 경로만 추가했다. Google 공통 동의 화면·다른 프로젝트 라우팅·DNS는 바꾸지 않았다.

SDK 이미지·실행 파일·AVD 사용자 데이터·APK·개인 키는 저장소와 공개 정적 디렉토리에 넣지 않는다. viewer 파일만 별도 서비스에 설치한다. 기존 API CI와 Android APK 빌드/lint를 유지하며 에뮬레이터 APK 자동 설치는 별도 운영 작업이다.

## 운영

PVE에서 `pct exec 317 -- systemctl start pleos-vehicle@1` / `stop pleos-vehicle@1`로 한 대만 관리한다. 상태/로그는 CT317의 `pleos-viewer.service`, `pleos-vehicle@1.service`, `/home/emulator/logs/`에서 확인한다. SDK는 /opt/android-sdk, AVD는 /home/emulator/.android/avd에 있다. 서비스를 추가로 시작하기 전에 실제 호스트 메모리를 확인한다.

소스: deploy/pleos-viewer. 같은 디렉토리의 unittest는 사용자10/최신성/비공개 값 제외/경로 탈출/제어 API 부재를 검사한다. 실제 기동·SDK 신호·WSS 화면은 별도로 확인한다.

[Pleos 설치·실행](https://document.pleos.ai/en/docs/connect/guide/getting-started/application-development/setup-connect-sdk-emulator) · [Pleos AVD 구성/GPU](https://document.pleos.ai/en/docs/connect/guide/getting-started/application-development/configure-pleos-connect-emulator) · [Pleos 앱 시작/RAM4GiB](https://document.pleos.ai/en/docs/pleos-only/getting-started) · [Android Linux KVM](https://developer.android.com/studio/run/emulator-acceleration).
