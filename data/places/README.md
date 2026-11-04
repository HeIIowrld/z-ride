# 차량 도로망으로 선별한 전국 장소 JSON 목록 (v3)

원본 **113,041건 중 17,923개 OSM 객체만** 남겼습니다. 나머지 **95,118건은 기본 목록에서 제거**했습니다. 산 정상 등 지형 지점과 접근 제한 시설, 도로망·같은 시설 주차장 연결 근거가 부족한 곳을 제외했습니다. 실제 현장 주행을 검증한 결과는 아닙니다.

| 저장 유형 | 남긴 건수 |
| --- | ---: |
| 명소 | 423 |
| 주차장 | 17,179 |
| 전기차 충전소 | 119 |
| 주유소·가스충전소 | 202 |

[선별 기준·검증 수준·재현 방법](DRIVING_FILTER.md) · [제외 ID와 사유](exclusions.json) · [이전 검토 이력](REVIEW.md)

## 사용

7개 데이터 파일은 JSON 객체 배열이며 파일당 최대 5,000건입니다. `manifest.json`의 `shards`만 장소 목록으로 읽으세요. `exclusions.json`은 삭제된 장소의 ID/사유 감사 목록이며 표시할 장소 데이터가 아닙니다. 파일 해시·크기·개수는 manifest, 필드 규격은 schema, 예시는 sample에 있습니다.

```js
import { readFile } from 'node:fs/promises';
const root = new URL('./data/places/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const places = [];
for (const shard of manifest.shards) {
  places.push(...JSON.parse(await readFile(new URL(shard.path, root), 'utf8')));
}
// 실제 차량 도착 좌표에는 places[i].drivingAssessment.arrival을 사용합니다.
```

기존 `latitude`, `longitude`는 시설 대표점입니다. 길찾기 목적지에는 `drivingAssessment.arrival`을 사용하세요. `networkRoundTrip: true`는 OSM 도로망상 주요도로에서 진입·복귀 연결 근거가 있다는 뜻이며, `fieldVerified: false`는 현장 주행·주차 가능 상태를 확인하지 않았다는 뜻입니다. 모든 레코드는 검토 대기(`pending`) 및 게임 비활성(`false`) 상태를 유지합니다.

`carAccess`와 `accessTags`는 태그 근거이며, 새 도로망 근거는 `drivingAssessment`입니다. `carAccess.routeVerified`는 외부 길찾기 엔진/현장 검증 완료와 혼동하지 않도록 계속 false입니다.

## 표시 분류

`displayCategory`와 `manifest.displayCategories`로 최대 10개만 표시합니다. 현재 건수가 없는 분류는 숨길 수 있습니다. `facts`의 OSM 세부 태그와 `theme` 게임 테마는 별도 필터 종류로 늘리지 않습니다. 저장용 `category`는 위 표의 4종입니다.

시설 하나가 별도 노드·면으로 중복 표현될 수 있어, 객체 수가 실제 시설 수와 같지는 않습니다. 같은 시설 주차장은 폴리곤 포함 관계와 직선거리로 선별했으며 도보 경로를 따로 검증하지 않았습니다. 접근 가능한 곳도 OSM 근거가 부족하면 빠질 수 있습니다.

## 출처와 한계

도로망·시설 형상은 **2026-11-02 21:21:26 UTC** Geofabrik 대한민국 OSM 추출본을 대조했습니다. 기존 시설 이름·대표점 등은 **2026-10-31 21:23:06 UTC** 스냅샷을 보존합니다. 출처별 URL·SHA-256과 선별 집계는 `metadata.json`과 `manifest.drivingFilter`에 있습니다.

현재 도로 폐쇄·사유지 미표기·영업·가격·충전/주유 재고는 확인하지 않았습니다. 전국 모든 차량 접근 가능 시설을 수록한 목록이 아닙니다. 실제 사이트 화면과 서버 API/게임 스폰은 이 데이터 변경으로 자동 갱신되지 않습니다.

© OpenStreetMap contributors / Geofabrik. 데이터 라이선스는 [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/), 출처와 이용 조건은 [LICENSE.txt](LICENSE.txt) 및 [OSM 저작권 안내](https://www.openstreetmap.org/copyright)를 따릅니다.

검증: `python3 tools/validate-place-catalog.py`, `python3 tools/test-place-review.py`, 작업용 의존성이 있는 환경에서 `python3 tools/test-driving-filter.py`.
