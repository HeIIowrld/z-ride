# Z-RIDE 서버 인프라 실행·인계

확인일: 2026-11-01 (Asia/Seoul). 담당 범위는 HTTP/WS API 제공·서버 실행·통신 검증이다. 지도 렌더링·GPS 권한 화면·차량 게임 UI는 앱 팀이 구현한다. 현재 실행 증거는 로컬 Node 서버와 실제 두 AVD의 통신이며, 아래 컨테이너 구성은 별도 상태로 구분한다.

## 현재 배포 단위

| 항목 | 현재 구성 |
| --- | --- |
| 런타임 | Node.js 22 이상, 표준 HTTP·WebSocket, ws 8.22.1 |
| 단위 | 단일 프로세스·단일 인스턴스 |
| 상태 저장 | 세션·방·전투·획득 원장을 프로세스 메모리에 보관 |
| 기본 로컬 주소 | HTTP `127.0.0.1:8000`, WebSocket `/ws` |
| 컨테이너 내부 주소 | `HOST=0.0.0.0`, `PORT=8000` |
| 컨테이너 외부 기본 공개 | 호스트 loopback `127.0.0.1:8000`만 publish |
| 진단 | GET `/healthz`, 계약 revision 3 |
| 종료 | 직접 실행한 Node가 SIGINT/SIGTERM을 받아 `app.close()` 수행 |

서버 재시작·컨테이너 교체 시 방과 재고가 사라진다. 볼륨만 붙여도 메모리 상태가 영속화되지는 않는다. 현재는 replicas를 늘리거나 여러 서버 뒤에서 같은 방을 분산 실행하지 않는다. 향후 다중 인스턴스를 사용하려면 공유 세션·방 라우팅·획득 원장과 동시성 보장이 필요하다.

이 PC의 실제 호스트 런타임은 Node v24.19.0이고 프로젝트의 engine 하한은 Node 22다. Node 22는 현재 Maintenance LTS다. 컨테이너 소스는 engine 하한에 맞춘 `node:22-bookworm-slim`을 사용하며 최신 보안 패치를 받는 태그다. Node 22 컨테이너를 실제 시험했다는 의미는 아니다. 동일 이미지를 장기간 재현하려면 실제 빌드·시험 후 digest를 기록해 고정한다. [Node 공식 지원 일정](https://github.com/nodejs/Release), [공식 Node 이미지](https://github.com/nodejs/docker-node)

## 로컬 직접 실행

`package.json`·기존 `pnpm-lock.yaml`을 그대로 사용할 수 있다. 컨테이너용 `package-lock.json`도 npm 10.9.2의 package-lock-only로 생성했다. 실제 의존성은 양쪽 모두 ws 8.22.1 하나다. 한 번의 의존성 변경에서 두 lock 파일의 버전·integrity를 함께 갱신한다.

기존 pnpm node_modules를 건드리지 않고 빈 임시 디렉터리에서 lock을 생성하고 `npm ci --omit=dev --ignore-scripts`를 시험했다. 정확히 ws 1개 설치·버전 8.22.1·양 lock의 integrity 일치가 확인됐다. Docker healthcheck의 동일 JavaScript는 기존 호스트 서버의 revision 3 응답으로 통과했다. [준비 검증 기록](../infra-preparation-results.json)

```powershell
Set-Location C:\Users\jeff4\Projects\Z-RIDE\server
pnpm install --frozen-lockfile
node server.mjs
```

HTTP와 WS의 호스트·포트는 같으며 `/ws`는 일반 JSON POST 경로가 아니라 WebSocket upgrade 경로다. 두 AVD는 호스트 별칭 `10.0.2.2:8000`을 사용한다. 차량 AVD와 폰 AVD가 서로의 127.0.0.1로 접근하는 구조가 아니다.

## 컨테이너 실행 명령

현재 PC에서는 `docker` 명령과 표준 Docker Desktop 실행 파일을 발견하지 못했다. **Docker image build·Compose config·컨테이너 구동은 아직 시험하지 않았다.** Docker 설치·방화벽·클라우드 계정은 변경하지 않았다. 이 파일들은 실행 가능한 구성을 준비한 상태이며 실제 Docker 통과로 표시하지 않는다.

Docker Engine과 Compose가 준비된 환경에서 서버 디렉터리 기준으로 실행한다.

```powershell
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
curl.exe --fail http://127.0.0.1:8000/healthz
docker compose logs --tail 100 api
```

이미 이 PC에서 직접 서버가 8000 포트를 사용 중이면 동시에 같은 포트로 시작하지 않는다. 별도 컨테이너 시험은 다음처럼 호스트 포트를 바꾼다. 이때 AVD 테스트 주소도 8001로 맞춰야 한다.

```powershell
$env:ZRIDE_PORT = "8001"
docker compose up -d --build
curl.exe --fail http://127.0.0.1:8001/healthz
```

종료는 `docker compose stop`이다. `stop_grace_period=10s` 안에 SIGTERM 종료가 처리되는지 실제 환경에서 확인한다. 재실행 후에는 새 세션·방을 만든다. 현재 프로토콜은 재시작 전 토큰·인벤토리를 복원하지 않는다.

Dockerfile은 `USER node`, 직접 `CMD ["node", "server.mjs"]`, 내장 fetch healthcheck를 사용한다. Compose는 init 프로세스·읽기 전용 파일시스템·최소 capability·메모리/CPU/로그 제한을 둔다. 이는 서버에 필요한 권한만 부여한 로컬 구성이다. [Node 이미지 공식 실행 권고](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md), [Compose 서비스 명세](https://docs.docker.com/reference/compose-file/services/)

## 앱 팀에 전달할 접속 정보

| 환경 | REST base URL | WebSocket URL | 현재 확인 |
| --- | --- | --- | --- |
| 같은 개발 PC | `http://127.0.0.1:8000` | `ws://127.0.0.1:8000/ws` | 서버 실행·단독 시험 |
| 이 PC의 Android AVD 두 대 | `http://10.0.2.2:8000` | `ws://10.0.2.2:8000/ws` | 실제 APK 통신 |
| Compose 호스트 8001 시험 | `http://10.0.2.2:8001` | `ws://10.0.2.2:8001/ws` | 미실행 |
| 배포 도메인 | `https://<domain>` | `wss://<domain>/ws` | 배포·TLS 미구성 |

서버 담당은 base URL·계약 revision·상태·연동 예제를 제공한다. 앱 팀은 URL 환경 설정, 토큰의 안전한 보관, 첫 WS auth, snapshot 적용, commandId 유지·오류 처리·재접속 UI를 구현한다. 운전자 앱의 UX/P 제한은 앱에서 즉시 차단하고 서버에서도 오래된 보고·허용되지 않는 전투를 거절한다.

## 외부 시연으로 넘어갈 때

도메인·배포 공급자는 아직 정해지지 않았다. 외부 폰 시연에 필요한 최소 변경은 HTTPS/WSS 종단점과 단일 서버 인스턴스다. 리버스 프록시는 HTTP와 `/ws` upgrade를 같은 서비스로 전달하고 WebSocket 연결 timeout·keepalive를 점검한다. 경로·토큰·원시 위치가 접근 로그에 남지 않도록 로그 필드를 검토한다. 현재 loopback publish를 외부 공개로 임의 변경하지 않는다.

현재 `/api/session`의 CAR_HOST 자체 등록과 게스트 세션은 폐쇄 데모용이다. 공개 서비스 전에 차량 등록·사용자 인증·요청 제한·영속 획득 원장을 정한다. 환경공단 인증키가 추가되면 서버 환경/secret 저장소에 두고 앱 APK나 소스에 넣지 않는다. OpenFreeMap 타일 요청은 폰이 직접 수행하므로 타일 전체를 서버에서 프록시·저장할 인프라는 필요하지 않다.

## 확인할 장애 경계

- HTTP health 성공은 WS 연결·방 승인·전투 gate 성공과 별도다. 테스트 시 각각 확인한다.
- WS가 끊기면 차량 전투는 pause하고, 재접속 후 최신 snapshot과 차량 보고를 다시 받는다. 명령의 재전송·재개 판단은 [현재 프로토콜](../protocol.json)과 앱 인계 문서를 따른다.
- 같은 commandId 재전송은 기존 영수증을 반환한다. 새 ID를 생성해 보상·지원·사격을 무조건 반복하지 않는다.
- 배포 재시작과 일반 연결 끊김을 구분한다. 메모리 서버를 재시작하면 기존 토큰·방 복구가 불가능하다.

이 문서는 서버 운영 경계를 위한 실행 안내다. 차량·폰 UI 상세 구현과 실차·실물 GPS 검증 결과는 각 앱 팀의 기록으로 관리한다.
