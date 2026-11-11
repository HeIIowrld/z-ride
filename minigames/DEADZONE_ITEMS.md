# Z-RIDE 아이템 × DEADZONE 특화 설계

DEADZONE(정차 습격, OVERRUN 기반) 코드는 **수정하지 않는다.** 이 문서와 zride-games 쪽 데이터·API만 DEADZONE의 실제 시스템 이름에 맞춰 설계해서, DEADZONE 팀이 나중에 "받아서 적용"만 하면 되게 한다.

## DEADZONE에 실제로 있는 것 (근거: packages/shared/src)
- 무기 6종 (defs.js) — 웨이브 도달 시 해금: SMG(0) · BREACHER 샷건(3) · LANCE 레일건(6) · RICOCHET 반사탄(9) · TORCH 화염(12) · THUMPER 유탄(15)
- 플레이어: HP 100, 실드 50(3.6초 뒤 재생), 대시 2회(2.4초 재충전)
- 플레이어 보정치 p.mods: dmg, rate, crit, critMult, pierce, bounces, explosive, lifesteal, dashExtra, dashTrail, slowAura, thorns, moveSpeed, shieldBonus, magnet, knock, spread, projSpeed
- 능력 6종 (abilities.js): SHOCKWAVE, TIME BUBBLE, BLINK STRIKE, TURRET, CHAIN BOLT, GRAVITY WELL
- 경기 중 줍는 것: score, health, ammo, surge(8초 강화)
- 좀비 10종: rusher, shard, bruiser, spitter, splitter, stalker, sapper(자폭), warden, elite, boss

## 설계 원칙
1. **"시작 상태"만 바꾼다.** 경기 규칙·좀비·웨이브 공식은 그대로. 아이템은 경기 시작 시 플레이어에게 얹히는 보정·해금·소모품.
2. **상한은 DEADZONE 업그레이드 1~2단계 수준까지.** 경기 중 얻는 업그레이드가 여전히 핵심이 되도록(예: HARD SHELL 1회 = 실드 +30 → 장갑판 최대 +30).
3. **공격력(dmg, rate, crit) 보정 장비는 없다.** 방어·이동·편의 위주. 무기는 "더 일찍 해금"으로만.
4. 1~4인 인원 배율(좀비 예산 1.00/1.72/2.44/3.16)은 건드리지 않는다.
5. 장비는 파티 차량 1대 공용 → 경기에선 **팀원 전원에게 같은 보정**.

## 1. 차량 장비 6슬롯 → DEADZONE p.mods
| 슬롯 | DEADZONE 연결 | 일반 | 고급 | 희귀/지역 |
| --- | --- | --- | --- | --- |
| 범퍼 | thorns(닿으면 피해), knock(넉백) | thorns +10 | thorns +20, knock ×1.15 | thorns +30, knock ×1.3 |
| 장갑판 | shieldBonus | +10 | +20 | +30 (지역 한정은 특화 옵션) |
| 타이어 | moveSpeed, dashExtra | 속도 ×1.04 | ×1.08 | ×1.12 또는 대시 +1 |
| 라이트 | magnet(줍기 범위), stalker/shard 표시 | magnet ×1.2 | ×1.4 | ×1.7 |
| 루프 | 시작 능력 1개(TURRET / CHAIN BOLT / SHOCKWAVE) | — | 능력 쿨다운 그대로 | 능력 + 쿨다운 −15% |
| 도색 | 스킨(능력치 없음) | 색 | 패턴 | 지역 문양 |

## 2. 무기 아이템 → 이른 해금
- 무기 아이템 1개 = 해당 DEADZONE 무기를 **경기 시작부터** 해금(원래는 웨이브 3~15).
- 매핑: 샷건류→BREACHER, 관통류→LANCE, 반사·튕김류→RICOCHET, 화염·용접류→TORCH, 투척·유탄류→THUMPER. 근접 무기 아이템은 DEADZONE에 근접이 없으므로 **BREACHER**로 매핑.
- 설치형(터렛·바리케이드) 아이템 → 루프 슬롯 대신 **1회용 TURRET 능력 충전**.
- 경기당 이른 해금은 **최대 2종**(파티 전체). 3종 이상 들고 와도 2종만 적용.

## 3. 소모품 → 경기 중 1회용
| 아이템 | DEADZONE 효과 |
| --- | --- |
| 의료 키트 | 사용 시 healPlayer 45 (FIELD REPAIR와 같은 양) |
| 탄약 상자 | 경기 시작 시 surge 픽업 1개를 팀 근처에 생성(8초 강화) |
| 연막 | TIME BUBBLE 1회 사용권 |
| 수리 키트 | 실드 즉시 완충 + 실드 재생 대기 0 (1회) |
- 파티가 가져갈 수 있는 소모품 = 종류별 최대 (인원 × 1.5, 반올림, 최대 6).
- 경기 끝나면 쓴 만큼 공동재고에서 차감.

## 4. 부품 → 정차 정비(경기 전 화면)에서 장비 강화
- 부품은 DEADZONE 안에선 쓰지 않음. 경기 전 garage 화면에서 **장비 등급 올리기** 재료(같은 슬롯 장비 + 부품 3개 → 한 단계 위). MVP에선 조합 제외 → 대신 부품 개수가 많을수록 "정비 보너스": 경기 시작 크레딧(업그레이드 재화) +부품 5개당 10, 최대 +40.

## 5. 지역 한정 → DEADZONE 상황 특화(좀비 종류 대응)
| 지역 | 아이템 | 슬롯/분류 | 효과 | 대응 좀비 |
| --- | --- | --- | --- | --- |
| 서울 | 네온 방패 | 장갑판 | 실드 +25, 야간 경기면 +35 | spitter(원거리) |
| 서울 | 지하철 레일 블레이드 | 무기 | LANCE 시작 해금 + pierce +1 | 줄 서서 오는 rusher |
| 인천 | 항만 크레인 훅 | 범퍼 | knock ×1.35 | bruiser 밀어내기 |
| 인천 | 공항 레이더 | 루프 | 시작 능력 CHAIN BOLT, stalker 위치 상시 표시 | stalker |
| 경기 | 물류 컨테이너 장갑 | 장갑판 | 실드 +40, 이동 ×0.95 (방어↑ 대신 느림) | sapper 자폭 버티기 |
| 강원 | 스노체인 타이어 | 타이어 | 대시 +1, 비·눈 조건 경기면 이동 ×1.08 | rusher 무리 회피 |
| 강원 | 산악 탐조등 | 라이트 | magnet ×1.5, slowAura +5 | shard 떼 |
- 수치는 위 상한 원칙 안. "야간·비" 조건은 경기 시작 시점의 실제 시각·와이퍼 상태(우리 서버가 판정해서 전달).

## 6. 우리 쪽이 DEADZONE에 넘기는 데이터 (계약안)
`GET /party/:id/deadzone-loadout` → DEADZONE이 경기 시작 때 한 번 읽어 적용
```json
{
  "schema": "zride.deadzone-loadout.v1",
  "partyId": "...",
  "conditions": { "night": false, "rain": true },
  "mods": { "shieldBonus": 30, "moveSpeed": 1.08, "dashExtra": 1, "thorns": 10, "knock": 1.15, "magnet": 1.4, "slowAura": 5, "pierce": 1 },
  "startWeapons": ["rail"],
  "startAbility": "chain",
  "consumables": { "medkit": 3, "surge": 1, "bubble": 1, "shieldRefill": 2 },
  "startCredits": 20,
  "skin": "paint_neon_grid",
  "gear": [{ "slot": "armor", "itemId": "...", "name": "네온 방패" }]
}
```
- 키 이름은 DEADZONE p.mods·무기 id·능력 id와 **똑같이** 맞춤 → DEADZONE 쪽 적용 코드는 "mods 곱/합 적용 + unlockWeapon + 능력 부여" 몇 줄이면 됨(그 코드는 DEADZONE 팀 몫, 이 문서 7번에 예시만 둠).
- 모든 값은 우리 서버에서 상한 적용 후 내보냄(폰이 보낸 값 아님).
- 경기 후 `POST /party/:id/consume` {items:{medkit:n, surge:n, bubble:n, shieldRefill:n}, source:'deadzone', roomCode} 로 소모 보고 받음.

## 7. DEADZONE 팀 적용 예시(참고용, 우리가 수정하지 않음)
```js
// MatchRoom: 방 생성 시 loadout = await fetch(`${LOOT}/party/${partyId}/deadzone-loadout`)
// sim.addPlayer 후:
for (const [k, v] of Object.entries(loadout.mods)) {
  if (['moveSpeed','knock','magnet'].includes(k)) p.mods[k] *= v; else p.mods[k] += v;
}
for (const w of loadout.startWeapons) sim.unlockWeapon(p, WEAPON_SLOT[w]);
```
