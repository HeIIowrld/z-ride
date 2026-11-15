# 스티커 아이콘 + 허브 정리 — 작업 지시서

대상: `minigames/` 만. `games/deadzone`, 저장소 루트 `server/`, `android/` 수정 금지(읽기만). 커밋·푸시 금지.
규칙: UTF-8(BOM 없음), PowerShell Set-Content/Out-File/리다이렉트로 파일 쓰기 금지, 이모지 금지, 외부 라이브러리·외부 이미지 금지. 게임 이름·기존 문구·게임 로직은 바꾸지 않는다. 팀이 main에서 바꾼 내용(journey 연동 등)을 되돌리지 않는다.

## 배경
팀이 정한 아이콘 스타일은 첨부 이미지와 `server/phone-client/route-sign/sign-*.png`(전봇대, 빗방울, 운전면허, 배터리, 좀비)에 있다:
**굵고 단순한 채운 실루엣(짙은 남색 #12283c) + 두꺼운 크림색 외곽선(#f4efe6) + 그 바깥 얇은 검정 테두리**, 둥근 끝, 내부 디테일은 2~4개의 큰 조각뿐, 스티커처럼 보임. 일부는 포인트 색 1개(노랑 #ffc400, 빨강 #e5242a, 청록 #18d6cf)와 간단한 광택.
현재 `shared/item-icons.js`의 아이템 아이콘은 가는 선 낙서라 무엇인지 알아볼 수 없다. 전부 이 스티커 스타일로 다시 그린다.

## 1. 아이템 아이콘 45종 (shared/item-icons.js)
- 형식: 64×64 viewBox SVG. 각 아이콘 = 실루엣 path들을 `<g>`로 묶고, 같은 그룹을 3번 그린다: (1) stroke 검정 #0b0f14, width 9 (2) stroke 크림 #f4efe6, width 6 (3) fill 남색 #12283c + 내부 디테일. stroke-linejoin/linecap round. 이렇게 하면 어떤 모양이든 스티커 외곽선이 자동으로 생긴다. 헬퍼 `sticker(shapes, {accent, details})` 로 구현.
- 내부 디테일은 크림색(#f4efe6) 또는 포인트 색 조각. 가는 선(2px 미만) 금지. 24px로 줄여도 실루엣만으로 구분돼야 한다.
- 공통 아이템은 포인트 색 청록 #52f1d0 계열, 특화 아이템은 주황 #ffd094 계열을 디테일에만 쓴다(실루엣은 항상 남색).
- 아이템별로 **무엇을 그릴지**(반드시 이 대상이 한눈에 읽히게):
  - blade 골목 레일 블레이드: 넓은 칼날 + 짧은 손잡이(사선) / neon-shield 네온 방패: 방패 + 가운데 번개 / rail-spear 지하 레일 창: 긴 창(마름모 창날) / arc-bow 접이식 활: 활 + 시위 + 화살 / signal-dart 신호 다트: 다트(뾰족 촉 + 깃 3개) / coil-launcher 코일 발사기: 굵은 원통 발사관 + 코일 고리 3개 / harbor-hook 항만 크레인 훅: 큰 갈고리 / ridge-staff 능선 지팡이: 지팡이 + 위에 산 모양 머리
  - battery-cell 배터리 셀: 세로 배터리 + 번개 / cable 전력 케이블: 말린 케이블 + 플러그 / circuit-board 회로 기판: 사각 기판 + 칩 + 다리 / coolant-cell 냉각수 셀: 캡슐 통 + 물방울 / fuel-can 연료 팩: 연료통(손잡이, 주둥이) / supply 보급품: 끈 묶은 상자 / part 정비 부품: 톱니바퀴 + 스패너 / ammo 탄약 상자: 탄창 상자 + 탄 3발 머리 / medkit 의료 키트: 손잡이 달린 구급 상자 + 십자 / turret 보조 포탑: 삼각대 위 짧은 포신
  - gear-bumper-a 완충 범퍼: 둥근 범퍼 바 / gear-bumper-b 강화 범퍼: 각진 범퍼 + 가드 바 2개 / gear-armor-a 차체 장갑판: 리벳 4개 박힌 판 / gear-armor-b 물류 컨테이너 장갑: 골판 컨테이너 면 / gear-tires-a 노면 타이어: 타이어(도넛 + 트레드 홈) / gear-tires-b 스노체인 타이어: 타이어 + 체인 X무늬 / gear-lights-a 탐조등: 원형 라이트 + 빛줄기 3개 / gear-lights-b 산악 탐조등: 라이트 + 산 실루엣 / gear-roof-a 루프 랙: 가로 바 2개 + 다리 / gear-roof-b 공항 레이더 돔: 반구 돔 + 접시 / gear-paint-a 빗길 도색: 페인트 롤러 + 물방울 / gear-paint-b 도심 반사 도색: 스프레이 캔 + 반짝임
  - smoke 연막 캔: 캔 + 구름 연기 / repair-kit 수리 키트: 공구함 + 스패너 / med-pack 응급 파우치: 파우치 + 십자 / flare 신호 조명탄: 막대 조명탄 + 불꽃 별 / ammo-crate 탄약 보급 상자: 나무 상자 + 탄 표시 / coolant 냉각수: 병 + 눈꽃(또는 물방울)
  - badge-seoul 서울 길 배지: 원형 배지 + 타워 실루엣 / postcard-incheon 인천 바람 엽서: 엽서 + 다리(현수교) / badge-gyeonggi 경기 들판 배지: 원형 배지 + 벼 이삭 / postcard-gangwon 강원 산길 엽서: 엽서 + 산 2개
  - quiz-time-card 시간 연장 카드: 카드 + 시계 / jump-grip 착지 그립: 발바닥 패드(미끄럼 방지 점) / wide-catcher 확장 받침대: 좌우 화살표 달린 긴 받침 / voltage-coil 고전압 코일: 코일 + 번개 / insulated-gloves 절연 장갑: 장갑 한 짝 + 번개 금지 표시(간단히 번개만)
- `itemIcon(item)` API와 `itemBadge` 사용처(가방·도감·토스트·차고·door-hud·빗방울 인게임 입자)는 그대로 동작. 배지 배경은 투명 또는 아주 옅게(스티커 자체가 외곽선을 가지므로 배지의 사각/원 테두리는 등급 표시용 얇은 링만 남긴다).
- `scripts/export-item-icons.mjs` 재실행해 `shared/assets/items/*.svg` 갱신(카탈로그의 45종 전부). `scripts/test-item-assets.mjs` 갱신: 45종 전부 고유, 각 SVG에 fill 실루엣 path가 있고(선만 있는 아이콘 금지), 채운 면적 비율이 viewBox의 18% 이상(대략 path bbox 기준), svg 파일 수 = 카탈로그 수.

## 2. 게임 표지 아이콘
- 팀 표지 PNG 4개를 복사해 쓴다: `server/phone-client/route-sign/sign-pole-jump.png`, `sign-raindrop.png`, `sign-license-quiz.png`, `sign-battery.png` → `minigames/shared/assets/signs/` (바이트 그대로 복사, 수정 금지). README 출처 줄에 "팀 공용 route-sign 표지 사용" 기록.
- 허브 게임 카드, 각 게임 시작 패널 상단, 결과 패널에 해당 게임 표지를 보여준다(카드에서 56~64px).

## 3. 허브(index.html, hub.js, style.css의 허브 부분) 정리
현재 문제: "게임 둘러보기" 아래 칩 3개가 좁게 구겨져 글자가 꺾임 / 상단 메뉴가 밑줄 링크 5개(개발용 "경로 재생" 포함) / 소개 카드의 장식 선이 글자와 겹침 / 게임 카드가 한 화면에 1.5장만 보임.
- 390×844 한 화면에 **게임 카드 3장이 모두 보이게**: 카드 = 가로형(왼쪽 표지 아이콘 64px, 가운데 제목+한 줄 설명, 오른쪽 최고 기록), 높이 약 96px, 카드 배경에 그 게임 장면 썸네일을 은은하게(불투명도 낮게) 깔기.
- 상단: 로고 + 오른쪽에 아이콘 버튼 2개(가방, 도감)만. "차고"는 가방 화면 안 링크로, "경로 재생"은 `?dev=1`일 때만 표시. 위치 상태("위치 대기 중")는 작은 상태 점 + 지역명 한 줄로.
- 소개 카드: 높이를 줄이고(약 120px) 장식 선 제거, shared/scenery 풍경 띠를 배경으로. 문구는 유지.
- 좌석 선택은 카드 목록 아래 한 줄 버튼("좌석: 오른쪽 창 · 바꾸기"). 소지품 요약은 아이콘 배지 3~4개 + 숫자.
- journey 연동 등 팀이 추가한 동작(hub.js의 기존 분기)은 유지.
- `window.__layoutCheck` 를 허브에도 추가해 360×640, 390×844, 430×932에서 겹침 0.

## 4. 가방·도감
- 가방 카드: 왼쪽 스티커 아이콘 48px, 제목, 수량 배지, 한 줄 설명, DEADZONE 효과 한 줄. 2열 격자(좁으면 1열).
- 도감: 지역별 섹션 + 격자 칸(4열). 미발견은 스티커 실루엣을 단색 어두운 회색으로(외곽선 없이) + "?" 없이 이름만 "???" 대신 "미발견". 발견 시 컬러 스티커 + 이름. 톱니 테두리 제거. 상단에 진행 막대(지역 한정 n/총).
- 두 화면 상단에 shared/scenery 풍경 띠(높이 72px)로 게임과 같은 분위기.

## 검증
- `node scripts/test-item-assets.mjs`, test-quiz-engine, test-loot, test-deadzone-loadout, test-scenery, sim-raindrop, test-polejump 전부 통과. 저장소에 minigames 관련 다른 테스트(예: server/test 의 minigames 정적 자산 검사)가 있으면 읽고, 새 파일 경로가 그 검사와 충돌하지 않게 한다(server/는 수정 금지, 충돌 시 보고).
- 바뀐 js/mjs `node --check`, `???` 깨진 한글 0건, BOM 0건.
- 마지막에 테스트 출력과 바뀐 파일 목록 출력.
