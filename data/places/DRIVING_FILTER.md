# 차량 도로망으로 선별한 장소 목록 (v3)

## 선별 결과

113,041건 → **17,923건 유지 / 95,118건 제외**. 주차장 17,179건, 명소 423건, 충전소 119건, 주유소 202건입니다. 산 정상 등 지형 지점 17,385건은 제외했습니다. 74,456건은 도로망 또는 같은 시설 주차장 연결 근거가 부족해 제외됐습니다. 따라서 제외 목록 전체를 실제로 차량 접근 불가능한 시설로 해석하면 안 됩니다.

도로망 대조는 차단 노드 172,181개와 회전 제한 관계의 도로 26,102개를 반영했고, 주요도로망에서 진입·복귀가 가능한 노드 8,834,524개를 계산했습니다. 남긴 장소 중 17,166건은 시설 내부 도로 노드, 1건은 같은 도로 노드, 756건은 같은 시설 주차장을 통해 연결했습니다.

## 남기는 기준

이 목록은 OSM 지도 근거로 차량 도착 지점을 추릴 수 있는 곳만 남긴 보수적인 부분집합이다. 원본 관광지/산/시설 목록 전체나 실제 현장 운전 검증 목록은 아니다. 기준을 통과하지 못한 곳은 기본 JSON 목록에서 제거하고, `exclusions.json`에는 OSM ID와 제외 사유만 남긴다. 제거한 전체 원본 레코드는 Git 이력에 있다.

1. 원본 PBF의 자동차 도로망을 구성한다. 일반 차량용 `highway` 유형만 사용하며, `track`, `path`, `footway`, 공사 도로 등은 포함하지 않는다.
2. `motorcar` → `motor_vehicle` → `vehicle` → `access` 우선순위로 접근 제한을 적용한다. 사유지·고객/허가/목적지 전용·미해석 값·조건부 제한 구간은 제외한다. 명시된 높이/폭/중량 제한, 일부 험한 노면도 보수적으로 제외한다. 태그가 없는 일반 자동차용 도로에는 유형별 통행 기본값을 적용한다.
3. 일방통행·역방향 일방통행·회전교차로를 방향 그래프로 반영한다. 회전 제한을 무시하지 않도록 해당 관계에 등장한 도로 전체와 via 노드를 제외한다. 실제 규칙보다 많이 제외될 수 있다.
4. 게이트·볼라드 등 차단 노드와 선형 담장/펜스의 공유 노드를 끊는다. 선형 장벽에서는 명시된 출입구·우회 가능한 통행 구조물 노드를 구별한다. 해당 노드 자체에 접근 제한이 있으면 통과시키지 않는다.
5. 주요 공용도로(`motorway`, `trunk`, `primary`, `secondary`, `tertiary`)에서 **진입과 복귀가 모두 가능한 노드**만 차량 도착 후보로 인정한다. 서로 다른 좌표선이 겹쳐 보인다고 연결하지 않고 OSM 노드 ID로 연결한다.
6. 주차장·주유소 면 안에 실제 연결 도로 노드가 있거나, 점 시설이 같은 도로 노드를 공유하면 직접 접근 근거로 인정한다. 다리·터널·층 높이가 다른 도로를 지상 시설과 단순 겹침으로 연결하지 않는다.
7. 명소와 충전소 등은 도로 연결된 주차장이 **같은 시설 면 안에 완전히 포함**되거나, 점 장소가 해당 주차장 면 안에 있을 때만 주차장을 통한 접근 근거를 인정한다. 장소 대표점에서 주차장 면까지 직선거리 100m 이하, 차량 도착 노드까지 150m 이하여야 한다. 담장·강·다른 필지 너머의 단순 인접 주차장은 연결하지 않는다.
8. 산 정상·고개·동굴 입구·절벽·바위·샘·단독 나무 등 지형 지점은 근처 도로가 있어도 제외한다. 현재 PBF와 원래 카탈로그 양쪽 태그를 확인한다. 주차장으로 연결되는 자연휴양림 같은 시설은 별개의 시설 근거로 판단한다.

## 좌표와 검증 수준

- 기존 `latitude`, `longitude`: 시설 대표점이다.
- `drivingAssessment.arrival`: **길찾기 목적지로 사용할 도로망 노드 좌표**다. 원래 대표점과 다를 수 있다.
- `networkRoundTrip: true`: OSM 그래프에서 주요도로망을 기준으로 진입·복귀 연결이 있음.
- `parkingId`: 같은 시설 주차장으로 연결한 경우 해당 주차장의 OSM ID. 직접 접근 근거에는 null.
- `poiToParkingDistanceM`: 같은 시설 주차장 면까지의 직선거리다. 실제 도보 경로 길이가 아니다.
- `fieldVerified: false`: 현장 진입로·주차 가능 구역·실시간 통제 상태를 확인하지 않았음.
- 기존 `carAccess.routeVerified: false`는 유지한다. `carAccess`는 태그 해석이고, 도로망 선별 근거는 새 `drivingAssessment`에 있다. 외부 내비게이션 엔진이나 실차로 경로를 검증한 결과로 혼동하지 않는다.

OSM에 누락되거나 잘못 연결된 도로·장벽, 현장 폐쇄, 고객 전용 미표기, 갱신 지연은 여전히 한계다. 같은 시설 안의 도보 동선도 별도 경로 탐색을 하지 않았다. **제외 = 실제로 차량 접근 불가능**이라는 뜻이 아니다. 접근 근거가 부족한 곳도 요청한 엄격한 목록에서 제외했다. 경계 밖으로 끊긴 도로·작은 섬·조건부 허용 등은 실제 접근 가능해도 빠질 수 있다.

## 형식·사이트 영향

목록은 `z-ride-place-catalog-v3`이다. v2의 필드에 `drivingAssessment`를 추가하고, 제외된 레코드와 빈 shard 파일을 제거했다. 표시 분류 사전은 최대 10개를 유지하며 현재 건수가 없는 분류는 화면에서 숨길 수 있다. 이 데이터는 계속 `reviewStatus: pending`, `gameEnabled: false`다.

현재 길벗 Sites 화면은 별도 소스·압축 행 형식을 사용하므로 이 PR만으로 바뀌지 않는다. 해당 사이트는 앞서 연결된 계정에서 편집 권한을 확인하지 못했다. 서버 API·게임 스폰·운영 배포에는 연결하지 않았다.

## 출처·재현

[Geofabrik 대한민국 추출본](https://download.geofabrik.de/asia/south-korea.html), © OpenStreetMap contributors, ODbL 1.0. 정확한 원본 URL·PBF SHA-256·스냅샷·도로망 집계·제외 사유는 `manifest.drivingFilter`와 `metadata.driving_filter`에 기록한다.

작업용 Python 환경에서 아래를 실행한다. PBF·전체 입력 JSON·pickle은 중간 파일이므로 커밋하지 않는다. pickle은 이 도구가 직접 생성한 로컬 파일만 읽는다.

```sh
python3 -m pip install -r tools/driving-requirements.txt
python3 tools/export-catalog-snapshot.py 139e8651a6fdf28cd97e4a06a38bfa548d12b6bc /tmp/zride-unfiltered.json
python3 tools/filter-driving-catalog.py extract /path/to/south-korea-261102.osm.pbf /tmp/zride-unfiltered.json /tmp/zride-network.pickle
python3 tools/filter-driving-catalog.py filter /tmp/zride-unfiltered.json /tmp/zride-network.pickle
python3 tools/test-driving-filter.py
python3 tools/test-place-review.py
python3 tools/validate-place-catalog.py
```

접근 태그와 장벽의 정의는 [OSM access](https://wiki.openstreetmap.org/wiki/Key:access), [OSM barrier](https://wiki.openstreetmap.org/wiki/Key:barrier), 주차장 분류는 [amenity=parking](https://wiki.openstreetmap.org/wiki/Tag:amenity%3Dparking)을 따른다. 위 선별 임계값과 제외 정책은 이 프로젝트의 보수적인 선택이다.
