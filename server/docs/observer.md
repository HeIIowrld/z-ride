# 참가자 관제 화면 — 서버 상태 기반 관찰

2026-11-01. `/observer`는 실제 제품 기능인 읽기 전용 관제 화면이다. 설명 자료용 웹페이지가 아니다. 같은 방의 운전자·좌석별 참가자 시야를 한 화면 또는 개인별 패널로 확인한다.

## 화면의 의미

- 서버가 확정한 방 상태·공동 보급·참가자 승인/연결·차량 게이트·좀비 HP·사격각·최근 사격을 렌더한다.
- 참가자별 패널은 같은 공동 전투 상태에 각 역할의 사격 범위를 적용한 **서버 상태 재구성**이다.
- 폰·차량 앱의 실제 화면 픽셀, 앱 내부 카메라, 마이크, 터치 화면을 중계하지 않는다. 실제 화면 미러링은 앱의 화면 캡처 권한·인코딩·전송·수신 클라이언트가 필요한 별도 작업이다.
- 관제 소켓은 게임 소켓과 별개다. 관제 접속 때문에 차량 또는 폰의 기존 연결이 교체되지 않는다.

## 접속

서버와 같은 주소의 `/observer`를 연다. 예: `http://127.0.0.1:8000/observer`. 배포 시 HTTPS/WSS를 같은 origin으로 제공한다.

### 운영자 관찰키

서버 옵션 `observerToken` 또는 실행 환경 `ZRIDE_OBSERVER_TOKEN`에 별도의 무작위 키를 지정한 경우만 운영자 목록 기능을 사용한다. 키는 배포 환경의 secret으로 공급하고 Git·URL·일반 로그에 넣지 않는다. 기본값은 비활성이다.

UI에서 운영자 모드를 골라 키를 입력하면 인증된 `GET /api/observer/rooms`로 방 목록을 받아 선택한다. 응답은 방 ID·상태·참가/연결 수·공동 보급·게이트 허용 요약만 포함한다. 키는 인증 헤더와 첫 WS 인증 본문에만 사용하며 브라우저 저장소에 넣지 않는다. 관찰키는 REST 게임 API를 인증하는 게임 세션 토큰으로 사용할 수 없다.

```http
GET /api/observer/rooms
Authorization: Bearer <read-only operator key>
```

### 차량 호스트의 특정 방

운영자 키가 없으면 UI의 차량 호스트 모드에서 기존 CAR_HOST 세션 토큰과 자신의 roomId를 입력할 수 있다. 서버가 실제 해당 방의 승인된 호스트 멤버인지 검사한다. 다른 방의 호스트·폰·승인 대기 참가자는 관찰 인증을 통과하지 못한다.

현재 게스트 CAR_HOST 발급은 폐쇄 데모의 신뢰 경계다. 이 관제 기능이 실차 인증·운영자 계정 체계를 완성한 것은 아니다. 실제 배포의 운영자 키는 별도 경계로 다룬다.

## WebSocket

`/observer/ws`에 연결한 뒤 5초 이내 첫 메시지를 보낸다. 토큰을 query string에 넣지 않는다.

```json
{"type":"observer.auth","token":"<operator key or own room host token>","roomId":"<room UUID>"}
```

성공 시 `observer.auth.ok`에 `readOnly=true`, `authorization=OPERATOR|ROOM_HOST`, `expiresAt`, `viewMode=SERVER_STATE_NOT_SCREEN_CAPTURE`가 오고 `observer.snapshot`이 이어진다. 운영자 소켓은 한 번 인증한 뒤 최대 1시간, 호스트는 기존 세션 만료까지 관찰할 수 있다. 만료·권한 상실은 close 4401이다. 관찰 소켓으로 게임 명령·차량 보고를 보내면 `READ_ONLY` 오류와 close 4403으로 차단한다.

15초마다 서버 Ping/Pong·heartbeat로 연결을 확인한다. 관찰 클라이언트는 재연결 시 기존 메모리 credential로 다시 인증하고 최신 전체 snapshot을 받는다. 만료·권한 거절은 재시도하지 않고 로그인 화면으로 돌아간다. 브라우저를 새로고침하면 키는 다시 입력해야 한다.

관제 데이터는 별도 allow-list로 만든다. 참가자의 sessionId·토큰·참가 코드·원시 위치·개별 pickup/방문 기록·명령 영수증은 전파하지 않는다. 닉네임은 DOM textContent로 표시하고 HTML로 해석하지 않는다. HTTP 자산은 외부 리소스 없이 제공하며 CSP·no-store·카메라/마이크/위치 권한 차단을 적용한다.

## 서버 연결 지점

`createObserverService({getSession,getRoom,getRooms,getGate,operatorToken})`를 생성한다. `getSession`은 원본 credential을 받아 현재 유효 세션을 찾는 서버 어댑터다. 저장소가 토큰 해시를 쓰더라도 관제 모듈은 DB 키 형식을 가정하지 않는다.

1. 일반 HTTP 인증 전에 `handleHttp(req,res,path)`를 호출한다. 정적 자산과 운영자 인증된 목록 경로만 처리한다.
2. 일반 게임 `/ws`의 경로 거절 전에 `handleUpgrade(req,socket,head)`를 호출한다.
3. 방 상태가 확정·저장된 뒤 `broadcast(room)`을 호출한다.
4. 종료 시 `close()`로 관찰 소켓·타이머를 정리한다.

`test/observer.test.mjs`는 실제 HTTP/WS 연결로 별도 관찰 권한·방 격리·읽기 전용·원본 게임 소켓 보존·위치/토큰 비전파·만료·origin·정적 자산을 검사한다. 실제 화면 시연은 루트의 브라우저/배포 검증 기록과 구분한다.
