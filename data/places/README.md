# 전국 장소 JSON 목록 (v2)

대한민국 OpenStreetMap 추출본에서 선정한 **113,041개 OSM 객체**입니다. 가상 데모 지점은 포함하지 않습니다. 기존 장소의 기준 시각은 **2026-10-31 21:23:06 UTC**, 주유소·접근 태그는 **2026-11-02 21:21:26 UTC**이며, 전국의 모든 실제 시설을 빠짐없이 수록한 목록은 아닙니다.

| 유형 (`category`) | 개수 | JSON 파일 |
| --- | ---: | --- |
| 탐험 후보 `attraction` | 52,429 | `attraction-000.json` ~ `attraction-010.json` |
| 주차장 `parking` | 52,801 | `parking-000.json` ~ `parking-010.json` |
| 충전소 `charging_station` | 1,131 | `charging_station-000.json` |
| 주유소·가스충전소 `fuel_station` | 6,680 | `fuel_station-000.json` ~ `fuel_station-001.json` |

각 파일은 일반 JSON **객체의 배열**이고 파일당 최대 5,000개입니다. 파일 목록·개수·SHA-256은 [manifest.json](manifest.json), 실제 레코드 예시는 [sample.json](sample.json), 원본 출처와 지역별 집계는 [metadata.json](metadata.json), 필드 규격은 [schema.json](schema.json)에 있습니다. `sample.json`은 전체 목록에서 뽑은 예시이므로 전체 개수에 다시 합산하지 않습니다.

## 차량 접근성·사이트 표시 분류

상세 검토와 적용 기준은 [REVIEW.md](REVIEW.md)에 있습니다. 사이트 메뉴는 `manifest.displayCategories`와 각 레코드의 `displayCategory`로 **최대 10개**만 표시합니다. 원본 `facts`나 `theme`을 별도 메뉴 종류로 합산하지 않습니다.

`carAccess`는 태그 근거만 분류합니다. `allowed_by_tag`도 실제 도로·입구 연결 확인을 뜻하지 않으며 모든 `routeVerified`는 `false`입니다. `accessTags`에는 접근 태그의 별도 원본 시각과 OSM ID 일치 여부를 기록합니다. 차량 도착점으로 사용하려면 주차장/입구와 도로 연결 검증이 추가로 필요합니다.

v2는 `displayCategory`, `accessTags`, `carAccess`를 추가하고 저장용 `category`에 `fuel_station`을 추가합니다. 원본 장소와 주유소·접근 태그의 기준 시각은 `manifest.snapshots`에 나눠 기록합니다.

## 읽기

저장소 루트에서 Node.js로 전체 목록 또는 특정 유형을 읽을 수 있습니다. `category` 필터를 제거하면 전체 113,041건을 읽습니다.

```js
import { readFile } from 'node:fs/promises';

const root = new URL('./data/places/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const places = [];
for (const shard of manifest.shards.filter(s => s.category === 'charging_station')) {
  places.push(...JSON.parse(await readFile(new URL(shard.path, root), 'utf8')));
}
console.log(places.length); // 1131
```

브라우저에서는 `manifest.json`과 필요한 유형의 JSON을 정적 파일로 제공한 뒤 `fetch()`로 읽으면 됩니다. 25개 데이터 파일은 약 75.3 MB이므로 지도 이동 때마다 전체를 다시 받지 말고 필요한 유형을 불러오거나 서버에서 검색·공간 색인을 구성하는 것을 권장합니다. 이 카탈로그는 정적 데이터이며, 기존 서버의 `/api/world/nearby`·`/claim`이나 테스트 스폰을 변경하지 않습니다.

## 주요 필드

| 필드 | 의미 |
| --- | --- |
| `id` | 원본 OSM 객체 식별자. 예: `node/123`, `way/456`, `relation/789` |
| `name` | OSM 이름 또는 이름 미등록임을 명시한 표시명 |
| `category` | `attraction`, `parking`, `charging_station`, `fuel_station` |
| `latitude`, `longitude` | WGS84 대표 좌표. 서버의 좌표 필드 이름에 맞춤 |
| `region`, `address` | 원본 추출 당시 지역명과 OSM 주소. 주소가 없으면 빈 문자열 |
| `theme` | 원본 카탈로그의 분류 제안: `forest`, `water`, `heritage`, `city`, `supply` |
| `facts` | OSM에서 추출한 접근·요금·운영시간·충전 소켓 등 태그. 누락 필드는 미확인 |
| `unnamed` | 원본 이름이 없어 표시명을 붙인 경우 `true` |
| `osmModifiedAt`, `sourceUrl` | 원본 객체 수정 시각과 OSM 조회 링크 |
| `reviewStatus`, `gameEnabled` | 모든 레코드가 `pending`, `false`. 현장 검토·게임 배치 전 상태 |

`attraction`은 관광명소뿐 아니라 공원·산·역사·문화·종교·체육 장소 등을 포함한 넓은 탐험 후보 분류입니다. 51,817건은 원본 이름이 없는 시설이며 이름을 추정해 만들지 않았습니다.  같은 실제 시설이 노드·면 등 별도 OSM 객체로 중복 표현될 수 있습니다. 지역 집계는 기존 자료의 16개 광역 경계 명칭을 보존하며, 주유소는 새 PBF의 광역 경계로 판정합니다. 혼합 지역 집계는 전국 현재 행정구역 통계로 사용하지 않습니다.

대표 좌표는 입구·주차 가능 구역·방문 허가를 뜻하지 않습니다. 충전소 실시간 상태와 현장 접근 가능 여부도 검증하지 않았습니다. `theme`은 아이템 배치나 획득 보상이 아니며, 공개 POI 좌표 외 사용자 위치·자격증명·OSM 편집자의 계정 정보는 포함하지 않습니다.

## 출처와 이용 조건

- 원본: [OpenStreetMap](https://www.openstreetmap.org/copyright), [Geofabrik 대한민국 추출본](https://download.geofabrik.de/asia/south-korea.html)
- 데이터 라이선스: [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/) ([LICENSE.txt](LICENSE.txt))
- 출처 표시: **© OpenStreetMap contributors**, 추출 제공 Geofabrik

데이터베이스를 이용·재배포할 때 ODbL의 출처 표시·공유 조건을 따르세요. 이 데이터 라이선스는 저장소의 별도 프로그램 코드 라이선스를 변경하지 않습니다. 원본 PBF의 다운로드 정보·해시·선정 및 제외 내역은 `metadata.json`에 보존했습니다.

검증: 저장소 루트에서 `python3 tools/validate-place-catalog.py`. JSON 규격, 25개 파일의 해시·크기·개수, 객체 ID 중복, 좌표, 유형·지역별 합계, 검토 상태를 검사합니다.
