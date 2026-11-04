# hjpark.net 연결 인계

2026-11-04: 현재 서비스 진입점은 **https://hyundai.hjpark.net/play**다. 개인 프로젝트에서 구성한 Proxmox 200 nginx가 315 컨테이너의 8000으로 HTTPS/WSS를 프록시한다. `hjpark.net/play`와 `play.hjpark.net`은 현재 배포 주소가 아니다. Google 승인된 JavaScript 원본은 `https://hyundai.hjpark.net`이고, 현재 GIS JavaScript popup 방식에는 승인된 리디렉션 URI가 필요 없다.

운영 환경은 `GAME_PUBLIC_ORIGIN=https://hyundai.hjpark.net`, `GAME_PHONE_JOIN_URL=https://hyundai.hjpark.net/play`, `GAME_BROWSER_API_ORIGIN=https://hyundai.hjpark.net`, `GAME_ALLOWED_ORIGINS=https://hyundai.hjpark.net`, `GAME_OBSERVER_ALLOWED_ORIGINS=https://hyundai.hjpark.net`, `GAME_TRUSTED_PROXY_ADDRESSES=192.168.0.200`을 사용한다. 클라이언트 ID는 비공개 `/etc/zride/zride.env`의 `GAME_GOOGLE_CLIENT_ID`에 저장한다. 실제 값이나 다른 접근키는 저장소에 넣지 않는다. Node는 기존 컨테이너 인터페이스에서 서비스하며 200 프록시 이외의 전달 헤더를 신뢰하지 않는다.

## 별도 프론트 배치가 필요할 때

DNS·Cloudflare 설정은 사용자의 개인 프로젝트 세션에서 관리한다. 이 변경은 DNS·인증서·포트포워딩을 자동 변경하지 않는다. 아래 host/path는 최종 주소로 바꿀 수 있다.

| 용도 | 예시 |
| --- | --- |
| PHONE 정적 웹앱 | https://play.hjpark.net/ 또는 사용자 페이지의 게임 하위 경로 |
| REST·게임 WS | https://api.hjpark.net / wss://api.hjpark.net/ws |
| 관제 | API origin의 /observer, 별도 읽기 키 |

`deploy/domain.env.example`의 PUBLIC_ORIGIN은 API origin, PHONE_PUBLIC_URL은 QR이 실제로 열 사용자 페이지의 완전한 URL이다. Browser API origin은 PHONE 코드의 HTTP/WS 목적지다. 예시 값을 적용하기 전에 원본 DB/catalog 경로와 세 가지 비밀키는 보존한다.

ALLOWED_ORIGINS는 정확한 scheme+host+port 목록이며 wildcard·경로를 허용하지 않는다. 필요한 JSON/Bearer preflight만 허용하고 cookie credentials는 허용하지 않는다. 게임 WS는 같은 allow-list, observer WS는 별도 allow-list다.

TRUSTED_PROXY_ADDRESSES는 API가 직접 보는 프록시 peer의 **정확한 IP**만 설정한다. 그 peer에서만 X-Forwarded-For를 오른쪽부터 읽고, 직접 요청의 위조 헤더는 무시한다. Cloudflare→Caddy→Node처럼 여러 hop이면 실제 네트워크에 맞는 설정이 필요하다. 불명확한 CF-Connecting-IP 헤더나 전체 사설 대역을 무조건 신뢰하지 않는다. HTTP IP별 제한은 그대로이므로 같은 NAT/프록시 뒤의 다수 사용자 영향은 부하 보고서를 함께 본다.

## 기존 서버와 별도 프론트

1. TLS 프록시가 API와 같은 컨테이너면 Node는 HOST=127.0.0.1로 바인딩한다. 프록시가 다른 컨테이너/Cloudflare Tunnel이면 해당 배치에 맞게 bind/upstream/신뢰 peer를 조정한다.
2. `deploy/Caddyfile.example`은 WebSocket을 포함한 API 프록시 템플릿이다. 실제 DNS·80/443·인증서 연결과 Cloudflare 설정은 개인 프로젝트 세션에서 완료해야 한다. 기존 8000 직접 포트는 TLS 전환 검증 뒤 별도로 정리한다.
3. 같은 서버의 /play는 config.js를 동적으로 제공한다. 별도 정적 호스팅은 다음 export를 사용한다.

```sh
node tools/export-phone.mjs https://api.hjpark.net /absolute/path/to/public-game
```

이 도구는 PHONE 파일 5개와 .nojekyll만 내보낸다. 키·DB·관제 정보를 포함하지 않는다. API/WS URL과 asset의 상대 경로·CSP를 설정하므로 사용자 페이지 하위 경로에도 배치할 수 있다. GitHub Pages 실제 게시/Cloudflare 계정 설정은 이 서버 변경에 포함하지 않는다.

## 연결 완료 뒤 확인

- HTTPS healthz 및 허용 origin의 OPTIONS 응답, 미허용 origin 403.
- 브라우저에서 API 호출과 wss 인증·재연결. 혼합 콘텐츠 오류 없음.
- QR이 최종 PHONE URL로 열리고 URL fragment가 주소에서 제거됨.
- 위치/GPS를 붙이는 경우 별도 WEB_GEOLOCATION 계약·권한 정책 구현 필요. HTTPS 전환만으로 현재 PHONE 데모에 실제 GPS가 생기는 것은 아니다.

[Cloudflare Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/) · [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
