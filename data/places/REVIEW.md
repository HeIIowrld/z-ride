# 차량 접근성·분류 검토

## 기존 목록의 의미

v1의 106,361건은 OSM 객체 목록이다. 시설 수·차량 목적지 수와 같지 않다. 같은 시설의 노드·면 중복이 남아 있고, 산 정상 16,415건도 포함됐다. v1은 101,146건에 일반 `access` 태그가 없었으며 차량별 접근 태그를 내보내지 않았다. 대표 좌표를 자동차 도착점으로 쓰면 안 된다.

## 실제 재집계 결과

- 원본 주유소 6,681개 OSM 객체 중 폐업 이름 1건을 제외해 6,680건 추가. 총 113,041건 / 25개 JSON 파일.
- 차량 태그상 허용 근거 161건 / 제한 근거 3,220건 / 미확인 109,660건. **실제 주행 경로 검증 완료는 0건**.
- 기존 106,361건 중 새 원본 OSM ID 일치 106,356건, 미일치 5건. 미일치는 기존 자료를 보존하고 접근 판정을 미확인으로 둔다.

| 표시 분류 | 건수 |
| --- | ---: |
| 산·숲·자연 | 16,607 |
| 바다·물가 | 1,163 |
| 역사·유적 | 3,284 |
| 문화·전시 | 2,580 |
| 공원·레저 | 14,801 |
| 종교시설 | 11,117 |
| 기타 명소 | 2,877 |
| 주차장 | 52,801 |
| 전기차 충전소 | 1,131 |
| 주유소·가스충전소 | 6,680 |

## 사용자 표시 분류: 최대 10개

사이트 필터·범례는 `manifest.displayCategories`의 10개 항목만 사용한다. 각 레코드의 `displayCategory`가 필터 값이다. `facts`는 출처의 세부 속성이므로 개별 태그 값을 메뉴 종류로 만들지 않는다. `theme`은 종전 게임 테마 메타데이터이며 표시 분류에 합산하지 않는다.

| ID | 표시 이름 |
| --- | --- |
| nature | 산·숲·자연 |
| waterfront | 바다·물가 |
| heritage | 역사·유적 |
| culture | 문화·전시 |
| leisure | 공원·레저 |
| religion | 종교시설 |
| attraction | 기타 명소 |
| parking | 주차장 |
| charging_station | 전기차 충전소 |
| fuel_station | 주유소·가스충전소 |

기존 `category`는 원본 3종에 `fuel_station`을 추가한 저장용 4종이다. 세부 표시 분류와 역할이 다르다. 우선순위는 시설형 category → 종교 → 역사 → 문화 → 물가 → 공원/레저 → 자연 → 기타 명소다. 사찰과 문화유산처럼 겹치는 곳도 표시 분류는 하나만 가진다. 원본 태그는 보존한다. 이는 태그 기반 일차 분류이며 개별 시설 의미까지 수작업 검수했다는 뜻이 아니다.

## 차량 접근 판정

`accessTags`는 새 PBF에서 같은 OSM ID를 찾아 보강한 접근 태그와 기준 시각이다. 미일치 객체는 `matched: false`로 표시한다. 기존 장소 좌표·이름은 기존 스냅샷을 유지하므로 최신 태그와 시점이 다를 수 있다.

`carAccess.status`:

- `allowed_by_tag`: 차량별 태그에 명시적인 허용 근거가 있음. 실제 도로 연결·진입 가능 확인과 다름.
- `restricted_by_tag`: 진입 금지, 사유지, 고객 전용, 허가 필요 등 제한이 있음. 제한 종류는 `reason`과 `evidence`로 구별한다.
- `unknown`: 허용 근거 부족, 조건부 제한, 원본 미일치 등으로 판단 보류.

차량 전용 태그 우선순위는 `motorcar` → `motor_vehicle` → `vehicle` → `access`다. 조건부·방향별 태그가 있으면 별도 해석 전까지 미확인이다. `access=yes`만으로 차량 허용을 확정하지 않는다. 주차장·주유소라는 사실도 허용 근거로 대체하지 않는다. 산 정상·동굴 등의 POI는 별도 차량 입구 검토가 필요하다.

**모든 `routeVerified`는 false다.** 도로망의 차량 통행 제한·게이트·진입로·시설 입구·공영/고객/사유 주차 구역과의 연결을 확인하지 않았다. 지금 데이터만으로 “차로 접근 가능한 장소만” 필터링했다고 주장할 수 없다. 실제 서비스의 차량 목적지에는 검토된 주차장/입구 좌표와 경로 검증이 추가로 필요하다. 태그상 허용만 있는 곳을 검증 완료 배지나 자동 게임 스폰으로 승격하지 않는다.

## 주유소 수집

Geofabrik 대한민국 PBF에서 `amenity=fuel`인 노드·선·면을 추출한다. 대한민국 광역 경계 폴리곤 안에 있는 객체만 추가하고, 폐업·철거 태그 및 명시적인 선박 전용 일부 객체는 제외한다. LPG 등은 주유소와 같은 표시 분류로 묶으며 연료 종류는 `facts.fuel:*`로 보존한다. 주유 브랜드도 메뉴 분류로 늘리지 않는다.

면은 내부 대표점을 쓰며 차량 입구로 간주하지 않는다. 이름 없는 시설은 이름 미등록으로 표기한다. 같은 실제 시설의 노드·면 중복, 태그 누락, 실제 영업 여부와 연료 재고·가격은 미검증이다. 오피넷 등의 실시간 영업·가격 데이터와 교차검증한 목록은 아니다.

## 출처와 재현

- [Geofabrik 대한민국 추출본](https://download.geofabrik.de/asia/south-korea.html)
- [OSM 차량 접근 태그](https://wiki.openstreetmap.org/wiki/Key:access)
- [OSM 주유소 태그](https://wiki.openstreetmap.org/wiki/Tag:amenity%3Dfuel)

데이터는 © OpenStreetMap contributors / ODbL 1.0. 원본 PBF URL·SHA-256·크기·스냅샷·경계 밖 제외 건수는 `metadata.fuel_source`와 `metadata.access_source`에 기록한다. `manifest.snapshotAt`은 기존 자료 시각이며, 혼합 스냅샷은 `manifest.snapshots`로 구분한다. 기존 지역 경계 16개 집계와 새로운 광역 경계 명칭이 다를 수 있어 원본별 지역명을 보존한다.

```sh
# osmium, shapely가 설치된 작업용 Python에서 실행. PBF·중간 JSON은 커밋하지 않는다.
python3 tools/extract-driving-pois.py south-korea-261102.osm.pbf /tmp/zride-driving-pois.json
python3 tools/review-place-catalog.py --fuel /tmp/zride-driving-pois.json
python3 tools/test-place-review.py
python3 tools/validate-place-catalog.py
```

변경은 PR의 정적 데이터 카탈로그에 적용한다. 운영 사이트의 배포·서버 API/게임 스폰 연결을 자동 수행하지 않는다. [길벗 지도 작업실](https://gilbeot-map-workshop.woojin-jang05.chatgpt.site)의 공개 HTML·스크립트를 읽기 전용으로 확인했다. 사이트 메타데이터도 기존 106,361건·2026-10-31 스냅샷과 일치한다. 현재 필터는 `attraction`(명소), `charging_station`(충전소), `parking`(주차장)의 **3종**이며 테마 5종은 별도 게임 메타데이터다. “명소”가 너무 넓은 것이 핵심 문제다. 사이트는 v1 압축 행 형식(`r[0]`~`r[10]`)을 읽으므로 이 저장소의 v2 JSON 객체를 그대로 바꿔 끼우면 안 된다.

사이트 적용 시에는 v2 객체를 명시적으로 매핑하고 `displayCategory`로 목록·검색·카운트·범례를 함께 묶어야 한다. 주유소 아이콘과 접근 근거 표시도 함께 추가해야 한다. 현재 연결된 Sites 계정의 소유/편집 가능 목록에 이 사이트가 없어 소스 수정·배포는 수행하지 못했다. 이 PR을 반영해도 현재 사이트 화면이 자동으로 바뀌지는 않는다.
