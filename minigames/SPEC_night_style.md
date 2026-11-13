# 주행 미니게임 3종 — 디자인 통일 + 팀 피드백 반영 + 아이템 정리 (작업 지시서)

대상: `minigames/` (pole-jump, raindrop, license-quiz, hub, bag, codex). **`games/deadzone`, `server/`, `android/`는 수정 금지**(읽기만).
게임 규칙·기록 형식·공통 모듈 API는 유지. 바뀐 파일 목록을 마지막에 출력.

## 작업 규칙 (먼저 읽기)
- 저장소 루트의 AGENTS.md, CONTRIBUTING.md, minigames/README.md, minigames/PLY_ITEMS_DEMO.md, minigames/shared/ply.css 를 먼저 읽는다.
- 모든 파일 UTF-8(BOM 없음). **PowerShell Set-Content/Out-File/`>` 리다이렉트로 파일을 쓰지 말 것**(한글이 `???`로 깨진 전례가 여러 번 있음). 저장 후 `???` 로 깨진 한글이 없는지 grep으로 확인.
- 이모지 금지. 외부 라이브러리·npm 의존성 추가 금지.
- 설명용 HTML 페이지를 새로 만들지 말 것(AGENTS.md).
- git commit/push 하지 말 것(작업 트리 변경만).

## 1. 디자인 통일
기준: `android/carapp/src/main/res/drawable-nodpi/arcade_*.webp` 키아트 4장 + `minigames/shared/ply.css` 토큰.
- 키아트 분위기: 밤, 짙은 남색·보라 배경, 네온 발광, 젖은 노면 반사. 이 분위기로 게임 캔버스를 바꾼다.
- 현재 캔버스는 흰 바탕 흑백 스케치(SPEC_sketch_style.md) → "어두운 배경 + 발광 선"으로 전환:
  - 배경 `var(--ply-bg)` #09121b 계열, 선은 밝은 색(`--ply-ink`) + 약한 글로우(shadowBlur)
  - 손그림 흔들림(shared/sketch.js)과 도형은 그대로 두고 **색만 반전·발광 처리 (다시 그리지 말 것)**
  - 포인트색: 기본 `--ply-primary` #52f1d0, 경고(과속·게임오버)는 #ff796c
  - 게임별 강조색을 shared/ply.css에 토큰으로 추가: 전봇대 #b5bcff, 빗방울 #c0baff, 면허시험 #ffc097 (차량 앱 `android/carapp/.../MainActivity.java`의 DRIVE_ACCENTS 등 게임별 색과 같은 계열인지 읽어서 확인)
  - 캔버스 코드가 CSS 변수를 직접 못 읽으면 `getComputedStyle(document.documentElement)`로 토큰을 읽는 작은 헬퍼(shared/theme.js 등)를 두어 색을 한곳에서 관리. 글로우는 성능을 위해 주요 선에만(방울 수백 개 전부에 shadowBlur 금지 — 큰 방울·캐릭터·테두리 위주).
- 허브 카드 썸네일도 같은 어두운 톤으로. style.css 앞부분의 흰 배경 규칙은 PLY 토큰으로 정리.
- 키아트 이미지를 그대로 가져다 쓰지 말 것(차량 앱 전용). 색·분위기만 맞춘다.
- SPEC_sketch_style.md 맨 위에 "색 규칙은 SPEC_night_style.md 지시로 대체됨" 한 줄 추가.

## 2. 폴짝 전봇대 피드백
문제: 시작하자마자 전봇대를 뛰어야 해서 바로 죽는다.
- 시작 후 처음 전봇대 3개는 **연습 구간**: 속도 ×0.6, 점프 타이밍에 "지금!" 표시와 탭 위치 안내, 실패해도 죽지 않고 같은 기둥에서 다시
- 연습이 끝나면 "시작!" 표시 후 기록 시작. 이후 속도는 ×0.8에서 천천히 올라간다 (기존 5개 구간 유지)
- 연습 구간은 기기당 첫 3판만 자동, 이후엔 일시정지 메뉴의 "연습 다시 보기"로 (일시정지 메뉴가 없으면 최소한으로 추가)
- 연습 구간의 착지는 점수·기록·아이템에 포함하지 않는다.
- `window.__polejump.getState()`에 `tutorial`(boolean), `tutorialStep` 추가
- 이번엔 뺄 것: 전봇대 사이 줄타기 이동, 동승자 여러 명이 같은 화면에서 같이 뛰기 → README의 "다음 후보"에 한 줄씩만 기록

## 3. 빗방울 캐치 피드백
문제: 게임 화면만 보면 차 창문인지 모른다.
- 창틀을 확실히: 굵은 창틀 테두리, 위쪽 지붕 라인, 아래 도어 트림과 손잡이, 한쪽에 사이드미러 윤곽 (범용 차량 형태, 실제 차종 형태 금지)
- 유리 너머 배경: 흐릿하게 지나가는 밤 풍경(가로등 빛 번짐, 건물·산 실루엣)이 차 속도에 맞춰 흐른다. 정차면 멈춤
- 유리 느낌: 방울에 배경 불빛이 비치는 하이라이트, 유리 전체에 옅은 반사 띠
- 시작 화면 첫 줄: "차 옆 창문에 맺힌 빗방울을 받아요"
- 처음 3초 동안 화면이 차 실내에서 창문으로 확대되는 연출 (탭하면 건너뛰기)
- scripts/sim-raindrop.mjs 가 계속 돌아가야 함(가짜 canvas에서 새 그리기 코드가 오류 없이).

## 4. 실시간 운전면허시험 피드백
문제: 지금 도로 상황에 맞는 문제가 나와야 한다.
- 문제마다 `roadContext` 필드 추가: highway / intersection / school_zone / urban / any
- 출제 시 현재 도로 상황에 맞는 문제를 먼저 고른다: 고속도로 주행 중 → 고속도로 법규(차로, 안전거리, 갓길), 교차로 접근 → 교차로 법규(우회전, 꼬리물기, 비보호 좌회전)
- 도로 상황 판정: 차량 feed의 roadType(있으면) → 없으면 제한속도 100 이상이면 highway, tbt 이벤트가 300m 안이면 intersection, caution:school_zone이면 school_zone, 그 외 urban
- dev 패널에 "도로 상황" 선택 추가. 문제 화면 위에 현재 상황 칩 표시 (예: "고속도로 주행 중")
- 문제 은행에 highway 8문제, intersection 8문제 이상 확보. 해설과 근거 조문 필수
  - **정확성 원칙**: 확실히 아는 내용만. 조문 번호가 확실하지 않으면 '도로교통법(조문 확인 필요)'로 쓰고 지어내지 말 것. 새 문제도 reviewStatus 'draft'.
- quiz-engine 테스트 추가: highway 상황에서 highway 문제가 먼저 나오는지, intersection도 동일
- 서버(`minigames/server`)가 문제를 고르는 경로에서도 roadContext가 전달·적용되게(클라이언트가 trigger에 현재 roadContext를 실어 보냄).

## 5. 아이템 정리
팀 결정: 공통 아이템(배터리 등) + 게임별 아이템 구조 유지, 에셋은 공용 공간에 모은다.
- `minigames/shared/item-icons.js` 아이콘을 공용으로 쓸 수 있게 `minigames/shared/assets/items/<id>.svg` 파일로도 내보내는 스크립트 `scripts/export-item-icons.mjs` 추가(실행해서 svg 파일도 생성·포함). README에 "다른 게임에서 쓰는 법" 3줄
- 아이콘 색을 ply.css 규칙에 맞춘다: 공통 = `--ply-common`, 특화 = `--ply-specialized`
- 이름 불일치 수정: 빗방울 획득 알림의 "냉각수 셀" → 카탈로그 이름과 일치시킬 것 (PLY_ITEMS_DEMO.md에 적힌 문제)
- 상자 테이블에 빠져 있는 13종 중 주행 게임과 어울리는 것 연결: 빗길 도색(빗방울 진짜 비 모드 최고 기록), 노면 타이어(전봇대 30회 착지), 신호 조명탄(면허시험 5연속 정답)
- PLY_ITEMS_DEMO.md의 획득 표 갱신

## 6. 검증용 훅 (스크린샷용, dev 전용)
- 각 게임 `?dev=1&autostart=1` 이면 동승자 확인·좌석 선택·인트로 연출을 건너뛰고 바로 플레이 상태로 시작(연습 구간도 건너뜀). dev=1 없이는 무시. 면허시험은 autostart 시 문제 화면 1개를 바로 띄운다.
- 자동화 브라우저(headless)에서도 그려지도록 requestAnimationFrame에만 의존하지 말고, autostart일 땐 첫 프레임을 즉시 한 번 그린다.

## 검증
- 기존 테스트 전부 통과 + 추가 테스트 통과: `node scripts/test-quiz-engine.mjs`, `node scripts/test-loot.mjs`, `node scripts/test-deadzone-loadout.mjs`, `node scripts/sim-raindrop.mjs`, 그리고 README/CI에 적힌 minigames 관련 검증이 있으면 그것도.
- 바뀐 모든 js/mjs `node --check`.
- 깨진 한글(`???`) 0건, BOM 0건.
- (스크린샷은 사람이 따로 찍음. `minigames/design/after_*.png` 자리는 비워 둠.)

## 공통 제약
- 차량 화면에는 주행 중 게임을 띄우지 않음. 동승자 폰 전용
- 차량 신호 없이도 끝까지 동작
- 캐릭터·그림은 오리지널, 현대차 이미지·실제 차종 형태 금지
- signature·privileged 권한 금지, 라이선스·출처 표기
