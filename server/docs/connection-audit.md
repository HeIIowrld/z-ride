# WebSocket EOF·연결 수명 점검과 앱 팀 전달 사항

점검일: 2026-11-01. 대상: `zride-demo-v1`, contractRevision 3, Node v24.19.0, ws 8.22.1. **서버의 정상 인증 연결을 10초·60초·차량 lease 만료 때 닫는 동작은 격리 시험에서 재현되지 않았다. 실제 APK의 EOF 원인은 미확정이다.** 이 감사에서는 실행 중 서버 코드·프로세스·기존 두 방을 바꾸거나 재시작하지 않았다.

## 1. 관측과 이번 시험의 범위

통합팀은 v0.3 APK의 기존 20개·지도 8개 확인 후 차량 소켓 EOF를 관측했다. 보고받은 시각은 `1793500606198`(2026-11-01 02:36:46.198 UTC)이다. 이후에도 PID 34748의 HTTP health는 정상, revision 3, rooms 2였다. 현재 클라이언트에는 자동 재접속이 없다고 통합팀이 확인했다.

이 사실만으로 서버·앱·에뮬레이터·ADB·전송망 중 어느 쪽이 원인인지 판정할 수 없다. 현재 서버는 소켓 error·close 상세를 기록하지 않아 당시 원인을 역추적할 증거가 부족하다. ADB 재시작과 시간상 가깝다는 이유로 네트워크 리셋이라고 단정하지 않는다.

이번에는 별도 임시 localhost 포트에서 같은 `createDemoServer()`와 독립적인 차량·폰 ws 클라이언트를 사용했다. 실제 port 8000 서비스나 Android/ADB 경로에는 접속하지 않았다.

## 2. 90초 격리 생존 시험 결과

실행: `node tools/ws-liveness-audit.mjs`. 이 감사는 오래 걸리는 별도 도구이며 기본 `node --test test/*.test.mjs`의 3개 시험에 자동 포함하지 않았다.

| 확인 | 결과 |
| --- | --- |
| 시험 시각 | 02:43:20.604–02:44:50.706 UTC |
| 실제 지속 시간 | 90,102ms |
| 최초 인증·역할 | 차량/폰 둘 다 auth.ok·snapshot 수신 |
| 차량 보고 중단 | 시작 후 10,102ms |
| lease 만료 | 14,344ms에 양쪽 state PAUSED, 사유 LEASE_EXPIRED |
| 이후 idle | 약 75.8초 동안 새로운 상태 트래픽 없이도 양쪽 소켓 OPEN |
| 종료 직전 폰 명령 | 90,101ms에 독립 mobile.collect 성공 |
| 시험 중 예기치 않은 close | 0 |

원본: [ws-liveness-results.json](../ws-liveness-results.json), 도구: [ws-liveness-audit.mjs](../tools/ws-liveness-audit.mjs). 시험 종료 후 감사용 소켓·임시 서버만 정리했다. 이 결과는 실제 APK·에뮬레이터 네트워크의 장기 안정성을 검증한 결과가 아니다.

## 3. 현재 서버의 시간 제한·닫힘 경로

| 설정·경로 | 현재 동작 |
| --- | --- |
| WebSocket 인증 5초 | auth 이전에만 적용. 인증 성공 때 타이머 해제 |
| 차량 보고 lease 6초 | 게임 명령 게이트와 PAUSED 전환에 사용. 소켓을 닫지 않음 |
| 세션 8시간 | HTTP 요청과 WS 수신 명령에서 만료 검사. WS는 4401 종료 |
| 같은 멤버의 새 소켓 | 이전 소켓을 4409로 교체. 이전 소켓 close가 새 연결 상태를 지우지 않게 검사 |
| 멤버 명령 영수증 10,000개 | 새 명령 실행 전에 COMMAND_LIMIT·4429로 닫음. 기존 명령 재전송은 영수증 반환 |
| HTTP requestTimeout 10초 | 전체 HTTP 요청 수신 제한 |
| HTTP headersTimeout 10초 | HTTP 헤더 수신 제한 |
| server.timeout | 실제 조회값 0. 일반 소켓 비활성 시간 제한을 설정하지 않음 |
| HTTP keepAliveTimeout | 실제 조회값 5초. HTTP 응답 후 연결 재사용 설정이며 인증 WS의 애플리케이션 idle TTL이 아님 |
| 라이브러리 프로토콜 검사 | 16KiB 초과 1009, 프로토콜 오류 1002, UTF-8 오류 1007 등이 가능 |
| 서비스 종료 | 실행 서버 close에서 모든 소켓 terminate |

Node의 HTTP request/header/socket/keep-alive 시간 제한은 서로 다른 설정이다. 현재 동작은 실제 설정 조회와 위 격리 시험을 함께 근거로 판단했다. [Node v24 HTTP 공식 문서](https://nodejs.org/docs/latest-v24.x/api/http.html), [ws 공식 자료](https://github.com/websockets/ws).

현재 코드에는 WS Ping/Pong을 주기적으로 보내거나 60초 뒤 자동 종료하는 루프가 없다. `ws` 문서는 조용히 끊어진 연결 감지에 Ping/Pong을 사용하는 방식을 설명한다. 이는 후속 운영 보강 후보이며 이번 감사에서 새로 켜지 않았다. [ws 연결 생존 감지](https://github.com/websockets/ws#how-to-detect-and-close-broken-connections)

차량 보고도 현재 영수증 수에 포함된다. 2초마다 새 commandId로 보고하면 다른 명령을 제외해도 약 5.6시간에 10,000개 상한에 닿을 수 있다. 운영 버전에서는 연결별 reportSeq 최신성 관리와 영속 게임 명령의 멱등 보관을 분리할 필요가 있다. 이번 짧은 시간의 EOF를 이 상한 탓으로 판단하지 않는다.

## 4. 앱 팀 재접속 계약

이 절은 앱 내부를 대신 구현하는 요청이 아니라 서버 통신 경계의 전달 사항이다. 현재 테스트 앱의 재연결은 수동이며, 아래 자동 복구 흐름은 후속 앱 작업이다. 정확한 API 전체는 [client-handoff.md](client-handoff.md)와 `openapi.json`, [protocol.json](../protocol.json)을 따른다.

1. EOF·close·응답 시간 초과 시 전투 입력을 막고 연결 끊김을 표시한다. 마지막 화면 값을 현재 서버 상태로 취급하지 않는다.
2. 같은 서버 프로세스와 유효한 credential이면 **기존 token+roomId**로 새 `/ws` 연결을 인증한다. 단절마다 새 guest/room을 만들 필요는 없다. 재시도는 backoff+jitter를 적용한다.
3. auth.ok와 서버 snapshot을 받은 뒤 현재 roomEpoch·stateVersion·승인·역할·inventory를 복원한다. 이전 미확인 명령을 재시도할 때에는 원래 commandId·본문을 유지한다. 사용자의 새로운 행동만 새 ID를 사용한다.
4. 차량 재연결은 서버에서 기존 플레이를 pause하고 UX·P·foreground를 미상/비활성으로 초기화한다. 새 소켓의 reportSeq를 초기화하고 실제 차량 상태를 다시 보고한다. 이후 사용자가 명시적으로 시작/재개해야 한다.
5. 폰 독립 수집은 차량 전투 게이트와 별개지만, 유효한 인증·승인 역할과 동승자 자가 확인이 필요하다. HTTP world API는 WS 연결 자체를 선행 조건으로 요구하지 않는다. WS가 끊긴 동안의 현재 재고는 room HTTP 조회로 재확인할 수 있다.
6. 서버 재시작·ROOM_NOT_FOUND·AUTH_EXPIRED로 기존 세션이 사라졌으면 데모에서는 새 세션·방·참가 승인이 필요하다. 현재 refresh/revoke/영속 복구 API가 없다.
7. claim HTTP의 inventory는 최초 영수증 시점 값이다. 이후 최신 WS snapshot의 재고를 오래된 영수증으로 덮어쓰지 않는다.

close 프레임을 받은 경우 코드·이유를 전달하고, 단순 EOF/전송망 종료와 구분해서 기록하는 것이 다음 원인 분석에 필요하다. 네이티브 클라이언트의 특정 라이브러리나 화면 구조는 이 계약에서 지정하지 않는다.

## 5. 운영 전 보강할 것

- **관측성:** 연결 ID·역할·가명 멤버 식별·서버 시각·close code/reason·error code·메시지 바이트 수·게이트 전환·재접속 수를 기록한다. token·참가 코드·원시 위치·전체 차량 메시지는 기록하지 않는다.
- **생존 감지:** 서버와 클라이언트의 Ping/Pong 또는 의미가 명확한 heartbeat를 설계한다. 전송망 생존과 차량 안전 상태 lease를 같은 것으로 취급하지 않는다.
- **인증 만료:** 현재 idle WS는 다음 수신 명령까지 8시간 만료를 재검사하지 않는다. 주기적인 만료 처리·로그아웃·폐기·재인증이 필요하다. 이번 짧은 시간의 EOF를 설명하는 원인은 아니다.
- **backpressure:** 현재 송신 버퍼 128KiB 이상이면 snapshot 전송을 생략한다. 클라이언트의 최신 전체 snapshot 재조회·지연 표시와 함께 검증해야 한다.
- **영속화·운영:** 단일 프로세스 메모리 방·재고·영수증, TLS·reverse proxy·상태 저장·종료/재기동·복구·여러 worker의 방 일관성은 별도 운영 범위다. 인프라 세부는 [infra-runbook.md](infra-runbook.md)에서 다룬다.

이번 감사는 재현되지 않은 EOF를 추정으로 고치기 위해 런타임을 변경하지 않았다. 다음 재현에는 위의 최소 로그를 먼저 갖추고, 실제 앱 경로의 close 시점과 서버 이벤트를 대조하는 것이 필요하다.
