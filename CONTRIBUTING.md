# Z-RIDE 협업 기준

이 리포의 중심은 **서버 API·기기간 통신·인프라**다. 차량·폰 앱의 화면, 지도 위젯, GPS/차량 SDK 처리, 게임 연출은 앱 팀이 맡는다. `android/`는 현재 서버 계약을 실제 AVD로 검증한 참조 클라이언트이며, 앱 팀의 최종 구현을 대신하는 배정이 아니다.

## 변경할 위치

| 작업 | 파일·디렉터리 |
| --- | --- |
| 서버 판정·세션·방·실시간 통신 | `server/server.mjs`, `server/world.mjs` |
| REST 계약 | `server/openapi.json` |
| WebSocket·메시지 계약 | `server/protocol.json` |
| 앱 팀 인계 | `server/docs/client-handoff.md` |
| 컨테이너·실행 환경 | `server/Dockerfile`, `server/compose.yaml`, `server/docs/infra-runbook.md` |
| 자동 검증 | `server/test/`, `.github/workflows/server-ci.yml` |

## 브랜치와 PR

`main`에서 `feat/<작업명>`, `fix/<작업명>`, `docs/<작업명>` 브랜치를 만든다. 한 PR에는 함께 검토할 수 있는 변경을 담고, 설명에는 바뀌는 동작·API 영향·검증 결과를 적는다. 통신 계약이 바뀌면 앱 팀이 확인할 수 있도록 요청/응답의 변경점을 구체적으로 남긴다.

API 변경은 런타임 코드와 함께 OpenAPI·프로토콜·관련 테스트·앱 팀 인계서를 갱신한다. 구현 예정인 경로를 이미 구현한 경로처럼 명세에 추가하지 않는다. 필드 이름·단위·enum·오류 코드·멱등 규칙을 양쪽 앱과 맞춘다.

## 로컬 검증

Node.js 22 이상에서 실행한다.

```powershell
Set-Location server
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm start
```

의존성 변경 시 `package-lock.json`과 기존 `pnpm-lock.yaml`의 버전·integrity가 일치하도록 갱신한다. 현재 서버는 단일 프로세스 메모리 저장이므로 재시작 시 세션·방·수집 재고가 사라진다.

Docker가 있는 환경은 `server/`에서 `docker compose up --build`로 실행한다. 기본 publish는 호스트 `127.0.0.1:8000`이다. 자동 CI는 Node 22에서 서버/계약 테스트 후 이미지를 빌드하고, 별도 loopback 포트로 실행해 `/healthz`를 확인한다. 클라우드 배포·이미지 레지스트리 push는 수행하지 않는다.

## 앱 팀 연결

PC 서버는 `http://127.0.0.1:8000`, Android AVD는 `http://10.0.2.2:8000`, WebSocket은 같은 호스트의 `/ws`다. 실제 폰·원격 서버의 주소는 인프라 담당이 별도로 제공한다. 앱마다 base URL을 설정 가능하게 한다.

앱은 현재 토큰·roomId로 재인증하고 최신 snapshot을 복원하는 재접속을 구현한다. 차량 앱은 실제 UX·P·foreground 신호를 보고하고 로컬 입력·오디오·UI를 즉시 차단한다. 폰은 자체 위치의 정확도·측정 나이·source를 전송한다. 정확한 메시지와 오류 처리는 [앱 팀 인계서](server/docs/client-handoff.md)를 따른다.

## 소스에 넣지 않는 자료

SDK·Android Studio·AVD 이미지·다운로드 압축파일·빌드 산출물·로컬 설정·실행 로그·세션 토큰·참가 코드·실제 사용자 위치를 커밋하지 않는다. 테스트 자격증명은 실제 비밀값 대신 명시적인 placeholder를 사용한다. 공유할 증거가 필요하면 개인정보와 실행용 비밀값을 제거한 별도 자료로 제공한다.

## CI 설정 근거

2026-11-01에 [공식 checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1), [공식 setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0), [GitHub Node.js CI 안내](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs)를 확인했다. 두 action은 해당 release commit SHA로 고정했다. GitHub-hosted CI에서 처음 성공한 실행을 컨테이너 검증 증거로 기록하고, 로컬에서 Docker가 없었던 이전 상태와 구분한다.
