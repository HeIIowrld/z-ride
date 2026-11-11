# 실시간 운전면허시험 — 구현 지시서 (Codex용)

기존 코드(허브, shared/, games/pole-jump, games/raindrop)를 먼저 읽고 같은 구조·스타일로 만든다.
- 빌드 도구·외부 라이브러리·npm 의존성 없음. 브라우저는 순수 ES modules, 서버는 Node 내장 모듈만.
- 흑백 손그림 스타일(style.css, shared/sketch.js 재사용), 세로 레이아웃, 한국어 UI.
- **인코딩: 모든 파일 UTF-8(BOM 없음). PowerShell Set-Content/Out-File 금지. 이모지 금지.**
- localStorage는 try/catch. 기존 게임을 깨지 말 것.

## 1. 게임 개요 (gameId 'license-quiz', games/license-quiz/)
주행 중 동승자 폰으로, 차가 지금 지나간 표지판·곧 할 회전·지금 날씨에 맞춘 교통법규 4지선다 문제가 온다. 게임오버 없음, 드라이브 1회가 1판.

## 2. 화면
- **대기 화면**: "드라이브 중" 상태, 지금까지 점수·정답 수·콤보, "다음 문제 대기 중" 표시, 하단 "드라이브 종료" 버튼. 정차 중(속도 < 3km/h 5초 이상)이면 "오답노트 복습" 버튼 활성화.
- **앱 안 알림 배너**: 문제가 오면 화면 위에서 배너가 내려옴 — 예 "방금 지나간 표지판, 무슨 뜻일까?" — 탭하면 문제 화면. 배너는 20초 타이머에 포함(탭 안 하면 시간초과 오답). 진동(navigator.vibrate)만, 소리 읽기(TTS) 금지.
- **문제 화면**: 위쪽 표지판 SVG(또는 상황 일러스트 SVG), 문제 문장, 보기 4개 큰 버튼(보기 순서 랜덤 셔플), 상단 남은 시간 바(20초).
- **결과 화면**: 정답/오답, 해설 2~3줄, 근거 조문, 획득 아이템, 점수 변화. "계속" 버튼.
- **성적표(드라이브 종료)**: 출제 수, 정답 수, 유형별 정답률, 최고 콤보, 평균 응답 시간, 획득 보급품, 오답노트 목록.
- **오답노트 복습**(정차 중에만): 틀린 문제를 다시 풀기. 맞히면 복습 보너스 +5점, 오답노트에서 제거.
- 첫 실행 시 shared/passenger.js ensurePassenger().

## 3. 규칙
- 정답 10점, 5초 안에 맞히면 +5. 연속 정답 콤보 배수 = 1 + floor(combo/3)*0.5 (최대 2.5배).
- 20초 넘기면 오답. 오답은 오답노트(localStorage 'zride.quiz.wrongNote', 문제 ID 목록)에 추가.
- 차 속도·주행 거리로 점수 주지 않음. **출제 간격 최소 60초**(빨리 달린다고 문제가 더 오지 않음).
- 같은 문제는 한 드라이브에 1번만.
- 난이도: 드라이브 초반(처음 5문제) 표지판 위주. 정답률 70% 이상이면 상황 판단·날씨 법규 비중을 높임.
- 트리거가 없으면 5분마다 일반 문제(지역·도로 무관 기본 문제).

## 4. 트리거 → 문제 선택 (shared/quiz-engine.js, 순수 로직, 브라우저·Node 공용)
트리거 이벤트 형식: `{ type, detail, at }`
| type | 의미 | 출제 시점 |
| --- | --- | --- |
| `tbt` | 다음 회전 안내 detail:{turn:'right'|'left'|'uturn', distanceM} | 회전 전에 해당 회전 법규 문제 |
| `caution` | 주의 구간 detail:{kind:'speed_bump'|'school_zone'|'slippery'|'falling_rocks'...} | 지나간 직후 "방금 지나간 표지판" 문제 |
| `camera` | 단속카메라 detail:{kind:'fixed'|'section'} | 단속·구간단속 문제 |
| `speedLimit` | 제한속도 detail:{kmh, roadType?} | 도로 종류 법정속도 문제 |
| `wiper` | 와이퍼 detail:{on, level} | on일 때 빗길 감속 문제 |
| `turnSignal` | 방향지시등 detail:{side} | 진로변경 신호 의무 문제 |
| `night` | 야간 | 전조등·야간 규정 문제 |
| `idle` | 일반 | 5분 무트리거 시 |
엔진 API: `createQuizEngine({ bank, now, rng })` → `onTrigger(event)` → 출제할 문제 또는 null(간격 제한/중복/해당 없음), `answer(questionId, choiceIndex, elapsedMs)` → 결과, `summary()`, 우선순위(위 표 순서), 1분 간격, 중복 방지, 난이도 규칙 포함.

## 5. 문제 은행 (games/license-quiz/questions.json, 40문제)
- 필드: id, type('sign'|'situation'|'weather_time'|'enforcement'), trigger(예 'tbt:right', 'caution:speed_bump', 'camera:section', 'wiper', 'turnSignal', 'night', 'speedLimit', 'idle'), sign(표지판 SVG 키 또는 null), question, choices[4], answer(0~3), explanation(2~3줄), legalBasis(예 '도로교통법 제25조'), reviewedAt: null, reviewStatus: 'draft'.
- 분포: 과속방지턱·어린이보호구역·우회전·빗길 감속·단속카메라 중심, **트리거별 최소 5문제**, 총 40.
- **정확성 원칙(매우 중요)**: 확실히 아는 내용만 쓴다. 근거 조문 번호가 확실하지 않으면 legalBasis를 '도로교통법(조문 확인 필요)' 처럼 쓰고 지어내지 말 것. 모든 문제는 reviewStatus 'draft'(사람 검수 전). 법 개정 시점 이슈가 있는 항목(예: 우회전 일시정지 규정 2022~2023 개정)은 최신 규정 기준으로, 해설에 그 취지를 반영.
- 사용자가 준 예시 문제(우회전, 전방 적색 신호)를 그대로 포함.
- 화면 하단에 "문제는 검수 전 초안입니다" 작은 표기(reviewStatus가 draft인 동안).

## 6. 표지판 SVG (games/license-quiz/signs.js)
- 직접 그린 오리지널 단순 벡터. 흑백 라인 스타일(테두리 모양 + 내부 단순 그림), **글자 없음**. 모양으로 구분: 주의 = 삼각형, 규제 = 원, 지시 = 원 또는 사각, 보조 = 사각.
- 최소: 과속방지턱(울퉁불퉁 노면), 어린이보호구역(어린이 두 명 실루엣), 미끄러운 도로(차와 S자 바퀴자국), 낙석, 우회전, 좌회전, 유턴, 횡단보도, 일시정지(팔각형, 글자 없이), 단속카메라(카메라 모양), 진입금지, 최고속도(원 안 빈칸 — 숫자 대신 막대 표시).
- 실제 사진·현대차 이미지 사용 금지.

## 7. 트리거 공급 (shared/vehicle.js 확장, 기존 동작 유지)
- 서버 WS `/vehicle` 메시지에 `{type:'trigger', event:{type, detail}}` 추가 수신 → feed가 `on('trigger', cb)`로 전달. 기존 `wiper`, `speedLimit` 메시지도 각각 trigger로도 변환(wiper on 변화 시, speedLimit 값 변화 시).
- 주석: 차량 앱이 Pleos NaviHelper onTBTInfo()/onCautionPointInfo()/onCameraAlert()/onCurrentRoadSpeedLimit(), Vehicle registerWiperState()/TurnSignal 값을 세션 서버로 보내고 서버가 /vehicle WS로 중계. 사무국 확인 전이라 없을 수 있음 → 그땐 idle 일반 문제로 계속 진행.
- dev 모드(?dev=1) 패널에 **트리거 버튼** 추가(이 게임에서만): 우회전 안내, 좌회전 안내, 과속방지턱 통과, 어린이보호구역 통과, 와이퍼 켜짐, 단속카메라, 구간단속, 방향지시등, 야간. dev 모드에서는 "출제 간격 무시" 체크박스(기본 켜짐)로 빠르게 테스트.
- 야간 판정: 로컬 시간 19~06시면 드라이브 시작 시 night 트리거 1회.

## 8. 서버 (server/quiz-server.mjs, Node 내장 모듈만)
- `node server/quiz-server.mjs` → 포트 8787.
  - 정적 파일 서빙(이 폴더 전체) — 이 서버 하나로 웹앱도 열림.
  - WebSocket(직접 구현, RFC6455 텍스트 프레임 최소 구현) 경로 `/vehicle`: 차량 앱/테스트 도구가 트리거를 보내면 같은 세션의 폰들에게 중계. 세션은 쿼리 `?session=ID`.
  - `POST /api/trigger?session=ID` (JSON 이벤트) — 차량 앱이 HTTP로 보낼 수도 있게. 받은 트리거를 서버측 quiz-engine으로 문제 선택(간격·중복 관리 서버 기준) 후 `{type:'question', questionId}`를 WS로 폰들에 푸시.
  - `POST /api/party/inventory`, `POST /api/records` — 받은 JSON을 server/data/*.jsonl에 append(나중 리더보드용). 
- 클라이언트: config.SERVER_URL이 null이면 서버 없이 브라우저 안에서 quiz-engine으로 동작(오프라인), 있으면 서버가 고른 questionId를 받아 출제.
- README에 실행법·트리거 예시 curl 추가.

## 9. 아이템·기록
- shared/inventory.js ITEMS에 `ammo:{name:'탄약 상자',type:'material'}`, `medkit:{name:'의료 키트',type:'material'}` 추가. 정답 1개당: sign→ammo, situation→medkit, weather_time→coolant, enforcement→supply.
- records.saveRecord({gameId:'license-quiz', score, durationMs, distanceM, stats:{asked, correct, byType:{...정답률}, maxCombo, avgResponseMs, wrongIds:[...], items:{...}}, endReason:'drive_end'}).
- 허브에 카드 추가("실시간 운전면허시험", 최고 기록 = 누적 정답 수 표시).

## 10. 테스트 훅
- window.__licenseQuiz = { getState(), trigger(type, detail) } — getState: {phase('waiting'|'banner'|'question'|'result'|'report'|'review'), score, asked, correct, combo, currentQuestionId, wrongNote, lastAskedAt}.
- node 스크립트 scripts/test-quiz-engine.mjs: questions.json 유효성(40개, 보기 4개, answer 범위, 필수 필드, 트리거별 5개 이상), 엔진 규칙(60초 간격, 중복 방지, 우선순위, idle 5분)을 검사해 PASS/FAIL 출력.

## 완료 조건
- node --check 모든 js, scripts/test-quiz-engine.mjs 전부 PASS.
- 기존 두 게임 영향 없음.
- 바뀐/새 파일 목록 출력.
