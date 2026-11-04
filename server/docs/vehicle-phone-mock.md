# 차량 QR·폰 로그인·수동 승인 통합 목업

2026-11-04 Asia/Seoul. https://hyundai.hjpark.net/play/demo 에서 기존 실제 REST/WS로 통신한다. 왼쪽은 센터페시아 목업, 오른쪽은 폰 참가 화면이다. 별도로 https://hyundai.hjpark.net/play/vehicle 을 띄우고 실물 폰에서 QR을 스캔해도 된다. REST 55개/계약 revision10 유지.

## 실행 순서

1. 차량에만 별도 테스트 접근키를 입력하고 파티 생성한다. 새 CAR_HOST와 방이 생성되고 실제 WS에 연결한다.
2. 차량이 party/invite를 호출해 120초 초대 QR을 직접 그린다. 통합 화면의 폰에도 같은 초대를 전달한다. 링크를 별도 탭으로 열 수도 있다.
3. 폰에서 Google 로그인 또는 닉네임·게스트 시작을 선택한다. 기존 게스트에 Google을 연결하면 같은 개인 ID를 유지한다. Google 계정 선택/동의는 본인이 진행한다.
4. 좌석·동승자 확인 후 참가를 요청한다. 다른 차량에 참가 중이면 전환 동의를 확인한다. 승인 전에는 대기 화면이다.
5. 차량의 해당 참가자 옆 ‘이 좌석 승인’을 누른다. 자동 승인은 하지 않는다. 양쪽에 같은 참가자·공동 보급이 나타나고 상단 연결 단계가 완료된다.
6. 원하면 차량의 주차 전투 시작/P·D 시뮬레이션과 폰의 데모 보급 수집을 확인한다. 종료 시 차량에서 파티 해산한다. 연결 끊김·새로고침 자체는 해산이 아니다.

QR 만료 뒤 새 QR을 발급하면 폰 초대 화면도 갱신된다. 로그인에 시간이 오래 걸려 만료되면 Google 로그인 후 다시 QR을 받으면 된다. iframe에서 Google 팝업/FedCM을 지원하지 않는 브라우저는 별도 폰 탭이나 실물 Safari를 사용한다.

## 통신과 권한

차량: session(CAR_HOST) → rooms → WS auth → party/invite → 승인 대기 snapshot → approve → 승인/연결 snapshot.

폰: client-config → guest 또는 Google challenge/exchange → invites/preview → me/invitations/accept → pending WS → 승인 후 PARTY_PLAY ticket/WS.

차량 접근키는 세션 발급 직후 입력에서 지우고 HOST 토큰은 차량 iframe의 메모리에만 둔다. 부모/폰 프레임으로 HOST·개인·플레이 토큰을 보내지 않는다. QR은 초대 URL fragment만 담고 폰이 즉시 주소에서 제거한다. 부모 화면은 같은 origin과 정확한 차량 자식 창에서 온 초대·표시용 단계만 받는다. 표시용 postMessage가 서버 권한을 부여하지 않는다. 외부 사이트 iframe은 CSP frame-ancestors self로 차단한다.

차량 관측은 SIMULATED_API_CLIENTS이며 2초 heartbeat/P·D/foreground만 모의한다. 실차 SDK 신호·공조/벨트 실행·실제 위치를 읽거나 제어하지 않는다. 페이지 숨김/차량 WS 끊김/신호 만료는 기존 서버 gate를 따른다. 기존 Pleos 앱의 최종 QR/승인 화면을 대체하는 제품 앱은 아니다.

## Google OAuth

기존 게임용 웹 클라이언트의 승인된 JavaScript 원본 https://hyundai.hjpark.net 과 운영 GAME_GOOGLE_CLIENT_ID 일치를 확인했다. GIS popup callback + 서버 nonce/ID-token 검증을 그대로 사용하며 리디렉션 URI/client secret은 사용하지 않는다. 같은 Cloud 프로젝트의 다른 서비스 클라이언트·공통 branding/동의 화면은 변경하지 않았다. 실제 사용자 로그인 동의는 본인이 완료해야 한다.

## 검증

vehicle-mock.test.mjs는 실제 REST/WS 서버와 차량 컨트롤러를 연결하고, canvas의 QR 픽셀을 별도 jsQR 디코더로 읽어 초대 URL을 확인한다. 그 초대로 폰 계정을 참가시켜 수동 승인 전/후 상태·같은 파티 연결·해산과 로그의 키/토큰 비노출을 검증한다. QR 생성기는 MIT qrcode-generator 2.0.4를 로컬에서 제공하고 해독기는 테스트 전용 jsqr 1.4.0이다.

브라우저에서는 좌우 iframe의 실제 API 흐름과 Google 공식 버튼을 확인한다. 서버 검증용 합성 Google 응답은 실제 사용자 동의를 대신하지 않는다.
