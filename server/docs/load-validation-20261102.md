# 동시접속·실시간 상태 검증

2026-11-02. 운영 서버에 부하를 가하지 않고 별도 CT316에서 시험했다. Node 22.23.3, SQLite WAL/FULL, 실제 장소 catalog 106,362건, CPU 1.5코어 상한·메모리 768MiB 상한이다. 클라이언트는 별도 Windows PC에서 LAN으로 연결했다. 공유 Proxmox 호스트의 다른 작업과 저장장치 상황에 따라 편차가 있다.

## 현재 권장 범위

시연은 우선 **4파티·16연결(차량 4+폰 12)** 이내를 권장한다. 현재 코드의 120초 시험에서 3,071개 입력 성공, 누락/오류/비정상 종료 0, ACK p95 54.37ms였다. 24연결 60초도 2,313개 성공·누락 0·p95 32.03ms였다. 32연결 120초도 6,153개 입력·누락 0·p95 76.39ms였다. 다만 변경 전 같은 32연결 120초에서는 p95 315.85ms가 관측됐다. 이번 변경은 저장 성능 최적화가 아니며 호스트/스토리지 편차를 배제하지 못한다. 더 짧거나 한 차례의 낮은 지연을 장시간 수용량으로 일반화하지 않는다.

100연결은 설정상 소켓 상한이며 원활한 100인 게임을 의미하지 않는다. 104개 연결 요청에서는 100개 수락·4개 503 거부를 확인했다. 단일 프로세스 시험이며 다중 서버·외부 LTE·실물 렌더링 FPS·수시간 soak는 측정하지 않았다.

## 부하 구성과 관측

파티당 HOST 1+PHONE 3. active는 차량 보고 0.5Hz, 폰당 사격 입력 2Hz, 방별 게임 타이머·SQLite 저장·snapshot 방송이다. 사격은 miss 입력으로 진행을 유지한다. 한 클라이언트당 미확정 요청 1개를 유지하며, 바빠서 전송하지 못한 예정 입력은 skipped로 별도 센다. 오류가 없더라도 skipped가 많으면 처리량을 충족한 것이 아니다.

| 코드/프로필 | 연결 | 실측 구간 | ACK p95 | 예정 입력 누락 | 관측 |
| --- | ---: | ---: | ---: | ---: | --- |
| revision 8 active | 16 | 120초 | 54.37ms | 0 | 오류/끊김 0, RSS 184.5MiB |
| revision 8 active | 24 | 60초 | 32.03ms | 0 | 오류/끊김 0, RSS 185.5MiB |
| revision 8 active | 32 | 120초 | 76.39ms | 0 | 6,153입력 성공, 오류/끊김 0 |
| revision 8 mixed | 32 | 60초 | 31.61ms | 0 | 3,072입력·250 HTTP 성공 |
| revision 8 mixed | 64 | 61초 | 896.55ms | 746 | HTTP_TIMEOUT 22, 503조회 중 466성공 |
| adee29d active | 32 | 120초 | 315.85ms | 21 | 오류 0, 재고/영수증 누적 영향 |
| adee29d active | 48 | 60초 | 497.22ms | 150 | 지연 증가 |
| adee29d active | 64 | 60초 | 952.21ms | 1,371 | event loop utilization 0.99 |
| adee29d idle | 104 요청 | 25초 | 해당 없음 | 해당 없음 | 100수락/4거부, 설정 상한 |
| adee29d mixed | 100 | 25초 | 696.16ms | 409 | RATE_LIMITED 30·HTTP_TIMEOUT 34 |

mixed는 active에 폰당 5~6초 간격 nearby HTTP 조회를 더한다. revision 8 mixed 64는 5,413입력 성공에도 예정 입력 746개를 생략했고 HTTP timeout 22회였다. 503개 조회 시작 중 466개가 측정 종료까지 성공했으며 남은 요청에는 종료 시 진행 중인 요청도 포함된다. 64연결을 권장 범위로 볼 수 없다.

모든 생성기가 같은 IP여서 IP당 120회/10초 제한이 병목이 된다. 제한을 풀어 숫자를 높이지 않았다. 실제 한 NAT 뒤의 팀원 수와 신뢰 프록시 설정도 점검해야 한다.

가장 큰 성능 개선 후보는 명령/타이머마다 전체 상태를 동기 JSON checkpoint하는 저장 구조다. 영수증이 쌓이면 지연이 커진다. 메모리 상한에 닿지 않아도 event loop가 포화될 수 있다. 방 단위 저장·타이머 저장 병합을 후속 검토하되, 커밋 전 성공 응답 금지와 멱등 보장을 유지해야 한다.

snapshot 지연 수치는 입력자 본인에게 해당 결과가 도착한 시간이다. 별도 실시간 통합시험에서 타 파티원 재고·캐시 무효화 수신은 검사하지만, 이 표를 WAN의 타 사용자 지연 벤치마크로 해석하지 않는다.

## 재현

`tools/load-server.mjs`는 별도 BENCH_STATE_DIR과 case별 DB를 사용하는 격리 서버다. 18080/18081을 공개하지 않는다. `/reset` 측정 구간을 초기화하며 CPU/RSS/event loop/DB 크기를 수집한다.

```sh
BENCH_STATE_DIR=/isolated-state BENCH_CASE=run1 ZRIDE_PLACES_PATH=/path/places.json node tools/load-server.mjs
node tools/load-client.mjs http://ISOLATED_HOST:18080 16 active 120 /path/result.json --isolated-benchmark
```

부하 도구는 benchmark metrics 응답과 명시적 인자 없이는 실행하지 않는다. 운영 주소에 사용하지 않는다. `active`, `idle`, `mixed` 프로필을 지원한다. case마다 깨끗한 DB로 시작하되, 시험 구간 안에서는 영수증이 실제로 누적된다. 원본 결과 JSON은 같은 디렉터리의 `load-results/`에 저장한다.

## 실시간 수집 보장

서버 통합시험으로 이동 전 거리 거부→이동 후 획득, 공동 재고 전파, 같은 파티 전원 목록에서 사라짐, 서로 다른 파티 분리, 동시 획득 1명 성공, 재전송/재접속/DB 복원을 검사한다. [파티 수집·리스폰 계약](collection-respawn.md)을 따른다.

현재 휴대폰 웹 참조 클라이언트는 버튼 데모이며 실제 브라우저 GPS 지도는 앱 팀의 별도 구현이다. Android 참조 지도에는 revision 무효화와 주기 ID 전달을 반영했다. 실제 iPhone Safari·차량 SDK·도로 이동 시험 완료를 뜻하지 않는다.

## 자동 검증 기록

PR #7 최초 head 6a7b1b3의 Linux Server CI에서 서버 78/78, 배포 경계 9/9와 실제 SQLite 정상 재시작/SIGKILL 복원이 통과했다. Android 참조 APK 두 개의 빌드·lint도 통과했다. Windows Node 24 전체 실행에는 기존 Connection: close/upgrade 전송 시험에서 ECONNRESET/timeout이 재현되어 Linux Node 22 CI를 배포 기준으로 사용했다. 새 수집/리스폰/복원 집중 시험은 Windows에서도 통과했다.
