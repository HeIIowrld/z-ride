# 전국 장소 JSON 목록

대한민국 OpenStreetMap 추출본에서 선정한 **106,361개 OSM 객체**입니다. 가상 데모 지점은 포함하지 않습니다. 데이터 기준 시각은 **2026-10-31 21:23:06 UTC**이며, 전국의 모든 실제 시설을 빠짐없이 수록한 목록은 아닙니다.

| 유형 (`category`) | 개수 | JSON 파일 |
| --- | ---: | --- |
| 탐험 후보 `attraction` | 52,429 | `attraction-000.json` ~ `attraction-010.json` |
| 주차장 `parking` | 52,801 | `parking-000.json` ~ `parking-010.json` |
| 충전소 `charging_station` | 1,131 | `charging_station-000.json` |

각 파일은 일반 JSON **객체의 배열**이고 파일당 최대 5,000개입니다. 파일 목록·개수·SHA-256은 [manifest.json](manifest.json), 실제 레코드 예시는 [sample.json](sample.json), 원본 출처와 지역별 집계는 [metadata.json](metadata.json), 필드 규격은 [schema.json](schema.json)에 있습니다. `sample.json`은 전체 목록에서 뽑은 예시이므로 전체 개수에 다시 합산하지 않습니다.

## 읽기

저장소 루트에서 Node.js로 전체 목록 또는 특정 유형을 읽을 수 있습니다. `category` 필터를 제거하면 전체 106,361건을 읽습니다.

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

브라우저에서는 `manifest.json`과 필요한 유형의 JSON을 정적 파일로 제공한 뒤 `fetch()`로 읽으면 됩니다. 23개 파일은 약 46.5 MB이므로 지도 이동 때마다 전체를 다시 받지 말고 필요한 유형을 불러오거나 서버에서 검색·공간 색인을 구성하는 것을 권장합니다. 이 커밋은 데이터 목록만 추가하며, 기존 서버의 `/api/world/nearby`·`/claim`이나 테스트 스폰을 변경하지 않습니다.

## 주요 필드

| 필드 | 의미 |
| --- | --- |
| `id` | 원본 OSM 객체 식별자. 예: `node/123`, `way/456`, `relation/789` |
| `name` | OSM 이름 또는 이름 미등록임을 명시한 표시명 |
| `category` | `attraction`, `parking`, `charging_station` |
| `latitude`, `longitude` | WGS84 대표 좌표. 서버의 좌표 필드 이름에 맞춤 |
| `region`, `address` | 원본 추출 당시 지역명과 OSM 주소. 주소가 없으면 빈 문자열 |
| `theme` | 원본 카탈로그의 분류 제안: `forest`, `water`, `heritage`, `city`, `supply` |
| `facts` | OSM에서 추출한 접근·요금·운영시간·충전 소켓 등 태그. 누락 필드는 미확인 |
| `unnamed` | 원본 이름이 없어 표시명을 붙인 경우 `true` |
| `osmModifiedAt`, `sourceUrl` | 원본 객체 수정 시각과 OSM 조회 링크 |
| `reviewStatus`, `gameEnabled` | 모든 레코드가 `pending`, `false`. 현장 검토·게임 배치 전 상태 |

`attraction`은 관광명소뿐 아니라 공원·산·역사·문화·종교·체육 장소 등을 포함한 넓은 탐험 후보 분류입니다. 51,044건은 원본 이름이 없는 시설이며 이름을 추정해 만들지 않았습니다. 같은 실제 시설이 노드·면 등 별도 OSM 객체로 중복 표현될 수 있습니다. 지역 집계는 원본 추출본의 16개 광역 경계를 그대로 보존했습니다.

대표 좌표는 입구·주차 가능 구역·방문 허가를 뜻하지 않습니다. 충전소 실시간 상태와 현장 접근 가능 여부도 검증하지 않았습니다. `theme`은 아이템 배치나 획득 보상이 아니며, 공개 POI 좌표 외 사용자 위치·자격증명·OSM 편집자의 계정 정보는 포함하지 않습니다.

## 출처와 이용 조건

- 원본: [OpenStreetMap](https://www.openstreetmap.org/copyright), [Geofabrik 대한민국 추출본](https://download.geofabrik.de/asia/south-korea.html)
- 데이터 라이선스: [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/) ([LICENSE.txt](LICENSE.txt))
- 출처 표시: **© OpenStreetMap contributors**, 추출 제공 Geofabrik

데이터베이스를 이용·재배포할 때 ODbL의 출처 표시·공유 조건을 따르세요. 이 데이터 라이선스는 저장소의 별도 프로그램 코드 라이선스를 변경하지 않습니다. 원본 PBF의 다운로드 정보·해시·선정 및 제외 내역은 `metadata.json`에 보존했습니다.

검증: 저장소 루트에서 `python3 tools/validate-place-catalog.py`. JSON 규격, 23개 파일의 해시·크기·개수, 객체 ID 중복, 좌표, 유형·지역별 합계, 검토 상태를 검사합니다.
