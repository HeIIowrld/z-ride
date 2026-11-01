# 차량 신호·역할·공조·벨트·오디오 확장 계약 제안

2026-11-01. **아래는 후속 확장 설계이며 현재 실행 서버의 구현 계약이 아니다.** 서버 코드·프로세스·기존 `/ws` 계약을 바꾸거나 재시작하지 않았다. 현재 듀얼 APK 연결 시험은 `protocol.json`의 `zride-demo-v1`로 계속 진행한다.

후속 revision 2에서는 사용자 요구에 따라 폰의 `mobile.collect` 독립 테스트 수집과 주차 공동 전투를 분리했다. 폰 수집은 차량 battle gate와 별개이며, 수집 supplies 1을 주차 `support.pulse`에서 소모해 5초 damage 3으로 연결한다. 현재 구현 계약은 상위 `protocol.json`·`README.md`가 우선한다. 이 문서의 벨트/HVAC/오디오 optionalSignals는 여전히 후속 제안이다.

## 1. 현재 구현과 확장의 경계

현재 서버는 UX·P·foreground·착석·충전 표시, 좌석별 사격각·운전자 지원만 처리한다. `vehicle.report`에 belt/HVAC 같은 임의 필드를 넣어도 현재 서버는 저장·전파·게임 판정하지 않는다. 아래 기능을 실제로 넣을 때에는 양쪽 앱과 서버에 명시적 capability 협상을 추가하고 해당 버전에서 지원한 기능만 활성화한다.

차량 기능은 API 존재만으로 채택하지 않는다. 차량 앱이 **SDK 초기화 → 기능 capability와 READ 권한 → 지원 area → 현재값 → 실제 콜백 → 해제**를 검증해야 한다. 서버는 앱의 보고를 독립적으로 인증하지 못한다. [Pleos Capability](https://document.pleos.ai/docs/pleos-only/connect-sdk-pleos/Vehicle/check-capability), [조회·제어 권한 구분](https://document.pleos.ai/docs/pleos-only/connect-sdk-pleos/Vehicle/vehicle-permission)

## 2. 넣을 위치와 데이터 형태

기존 안전 게이트 `ux/gear/foreground/seats`는 유지하고 별도 `optionalSignals`에 선택 기능을 넣는 것이 좋다. 임의의 차량 속성을 통째로 올리는 `rawProperties`는 두지 않는다. 허용 필드와 용도가 정해진 값만 받는다.

```json
{
  "type": "vehicle.report",
  "commandId": "unique-id",
  "reportSeq": 42,
  "ux": "ALLOWED",
  "gear": "P",
  "foreground": true,
  "seats": [{"seat": "FRONT_PASSENGER", "occupancy": "OCCUPIED"}],
  "optionalSignals": {
    "schemaVersion": 1,
    "seatBelts": [{
      "seat": "FRONT_PASSENGER",
      "availability": "SUPPORTED",
      "value": true,
      "source": "PLEOS_VEHICLE_CALLBACK",
      "sampleSeq": 7,
      "receivedAgeMs": 500,
      "measurementAgeMs": null
    }],
    "hvac": [{
      "area": "FRONT_PASSENGER",
      "signal": "CURRENT_TEMPERATURE_C",
      "availability": "UNSUPPORTED",
      "value": null,
      "source": "NONE",
      "sampleSeq": 0,
      "receivedAgeMs": null,
      "measurementAgeMs": null
    }],
    "gameAudio": {
      "availability": "SUPPORTED",
      "focus": "GAINED",
      "routing": "DEFAULT_MEDIA",
      "directionalRendering": "STEREO_ONLY"
    }
  }
}
```

`availability` 후보는 `SUPPORTED / UNSUPPORTED / NO_PERMISSION / SERVICE_DISCONNECTED / UNKNOWN`이다. value는 지원돼도 null일 수 있다. `receivedAgeMs`는 앱이 콜백을 받은 뒤 경과한 시간이고 센서 측정 나이의 보증이 아니다. measurement timestamp가 없는 SDK에서는 `measurementAgeMs=null`을 유지한다. `sampleSeq`는 해당 신호의 연결 세대 내 증가값이고 reportSeq는 전체 전송 순서다.

`source`는 `PLEOS_VEHICLE_CALLBACK / AAOS_CALLBACK / TEST_ADAPTER / NONE`처럼 제한한다. TEST_ADAPTER를 실제 차량 신호로 표시하지 않는다. 서명을 제공하지 않는 한 source 문자열도 클라이언트의 주장이다.

## 3. 신호별 권장 용도와 게임 효과

| 신호 | 역할·효과 제안 | 서버 전송·판정 | 피할 설계 |
| --- | --- | --- | --- |
| 실제 착석 | 이미 구현된 좌석별 사격각과 역할 관리 | 수동 폰 매칭·OCCUPIED/EMPTY/미상 근거를 함께 판정 | 착석 센서만으로 사람·폰 신원을 식별했다고 주장 |
| 벨트 | 관제의 출발 준비 표시·안전 상태 카드. 주차 게임의 필수 조작은 아님 | 선택 정보. 보상·사격 피해량에 연결하지 않음 | 벨트 풀기/반복 체결을 게임 입력·점수 조건으로 사용 |
| HVAC 현재 온도 | 지원·가용성이 확인되면 초기 배경의 색감 같은 선택적 표현 | 가능하면 차량 로컬 처리. 서버는 실제 필요할 때만 `COOL/NORMAL/WARM/UNKNOWN` 같은 거친 분류 수신 | 설정 온도를 실제 실내 온도로 오인, 공조를 일부러 바꿔 보상을 얻도록 설계 |
| HVAC 풍량/모드 | 지원 상태 진단·옵션 정보. 현재 게임의 필수성 낮음 | 기본 전송 대상에서 제외. 게임에 구체적 용도가 생긴 뒤 허용목록 추가 | 냉난방·성에 제거 등 실제 기능을 게임 난이도 조작으로 강제 |
| 차량 오디오 | 왼쪽/오른쪽 위협을 짧은 게임음과 시각 효과로 표현 | 서버는 의미 단위 cue만 전송, 클라이언트가 포커스·UX·기능을 확인해 재생 | 물리 스피커 위치 제어를 검증 없이 약속, 경고음·통화·내비를 덮는 음량 제어 |
| 조명·창문·도어·좌석 이동 | 현재 게임 목표에 필요 없음 | 기본 범위 제외 | “API가 있으니 모두 사용” 또는 폰에서 실제 차량 기능 조작 |

벨트 관련 구현 후보는 `checkSeatBeltBuckledCapabilities`, `getCurrentSeatBeltBuckledState`, `registerSeatBeltBuckledState`다. HVAC 후보는 `checkHvacTemperatureCurrentCapabilities`·현재 온도 get/구독, 풍량 capability/get/구독이다. 확인한 Vehicle 소스는 각 기능의 capability·지원 영역·단위를 먼저 검사하도록 안내한다. 다만 현재 AVD 실수신을 이 문서로 보장하지 않는다. 관련 조회 권한은 Seat의 `pleos.car.permission.CAR_SEATS`, HVAC의 `pleos.car.permission.CAR_CLIMATE`이며 함수별 실제 어노테이션을 다시 확인한다.

## 4. 서버의 권위와 projection

- 역할·사격각·지원 효과·적 HP는 현재처럼 서버가 판정한다. 폰이 역할·효과·피해량·센서값을 직접 확정할 수 없다.
- 호스트는 자기 차량의 지원/미지원·진단 사유를 볼 수 있다. 승인된 폰에는 **본인 좌석 근거·사용 가능한 게임 효과·필요한 cue**만 보낸다. 다른 좌석의 벨트·상세 공조값을 전체 broadcast하지 않는다.
- 미승인 참가자에게는 현재처럼 자기 pending 정보만 제공하고 차량 신호는 숨긴다.
- raw 벨트/HVAC 이력은 기본 저장하지 않는다. 자세한 차량 정보 없이도 게임이 동작하도록 한다. 데이터가 필요하면 수집 목적·전송·보유·철회 범위를 먼저 정한다.
- 물리적 차량 제어 명령은 정의하지 않는다. `support.pulse`는 가상 피해 지원이고 실제 공조·조명·충전 출력을 바꾸지 않는다.

## 5. 신선도와 실패·중단

| 종류 | 신선도·실패 처리 제안 |
| --- | --- |
| UX·P·foreground | 기존 필수 게이트 유지. 미상·끊김·만료는 닫힘. 선택 신호로 우회 불가 |
| 착석 | 현재 EMPTY 잠금은 UNKNOWN/누락으로 자동 해제하지 않음. 새 OCCUPIED 또는 명시적 수동 재승인 경로 유지 |
| 벨트 표시 | 예시 TTL 5초 후 UNKNOWN 표시. 값을 유지해 보여 주더라도 ‘마지막 관측’임을 명시. 파생 게임 점수 없음 |
| HVAC 배경 표현 | 예시 TTL 30초 후 중립 표현. 미지원·거부·오류도 중립. 시간값은 제품 제안이고 공식 SDK 수치가 아님 |
| 오디오 | 재생 시점의 로컬 포커스·UX·화면 상태 확인. 과거 cue를 재접속 후 몰아서 재생하지 않음 |

서버 TTL은 서버 수신 단조 시계로 관리하는 것이 좋다. 현재 데모의 reportSeq 검사는 패킷 순서를 보완할 뿐 SDK 콜백 자체가 최신 센서 측정임을 인증하지 않는다. 앱은 부분 콜백의 오래된 필드가 전체 상태를 덮지 않도록 어댑터에서 현재 상태를 조합해야 한다.

## 6. 오디오 이벤트는 물리 스피커 API와 구분

예시 확장 이벤트는 `audio.cue {cueId, eventId, vehicleRelativeAngleDeg, intensity, expiresInMs}` 정도로 둔다. 서버는 “좌측 위협”이라는 게임 의미를 보내고, 차량 앱이 검증된 스테레오 패닝 또는 기본 미디어 출력을 선택한다. 채널·오디오 존·시트별 스피커를 실제로 분리할 수 있다는 검증 전에는 `rearLeftSpeaker.play` 같은 API를 만들지 않는다.

게임음은 `AudioAttributes.USAGE_GAME`과 오디오 포커스를 사용하며 포커스 상실·주행 제한·Suspend에서 중지/정리한다. 방향성 소리가 없어도 같은 시각적 경고를 제공해 게임 판정상 불이익을 주지 않는다. Pleos는 게임 오디오를 MUSIC 컨텍스트로 매핑하며 통화·긴급음 등과의 포커스 정책을 설명한다. [Pleos 오디오 포커스](https://document.pleos.ai/docs/pleos-only/vehicle-app-developer-guide/audio-focus-development-guide/audio-focus-development)

## 7. 다음 구현 순서

1. 현재 dual APK + 서버 연결·실제 UX/P/좌석 신호 시험을 끝낸다.
2. 진단 화면에 belt/HVAC의 capability·권한·area·get·콜백 결과를 따로 기록한다.
3. 실제로 읽힌 신호 가운데 게임에서 설명 가능한 하나만 선택해 optionalSignals를 구현한다.
4. 서버는 판정에 필요한 최소 파생값만 받아 projection·만료·권한을 시험한다.
5. 주행 중단·앱 숨김·권한 거부·미지원·지연 값에서도 기존 게임 안전 게이트가 유지되는지 회귀 시험한다.

이 단계에서 API를 추가했다는 이유로 주행 중 게임·실제 차량 제어·원격 차량 인증·개인별 스피커 제어까지 구현됐다고 쓰지 않는다.

## 8. 현재 120초 참가 코드 갱신 — 서버 변경 불필요

현재 코드에는 별도 `/pairings` 경로가 없지만 **기존 호스트 세션 토큰으로 POST `/api/rooms`를 다시 호출하면 같은 roomId에서 코드만 갱신**하는 동작이 이미 있다. 기존 방의 멤버·게임 진행·HP는 유지되고 이전 코드는 폐기되며 새 코드는 120초 동안 한 번만 사용할 수 있다. 새 코드 snapshot도 호스트에게 전파된다.

차량 UI의 “코드 새로고침”은 `/api/session`을 새로 만들지 말고 **기존 Bearer token으로 `/api/rooms`만 재호출**해야 한다. 매번 새 세션을 만들면 새 방이 만들어져 연결 시험이 어긋난다. 갱신한 코드는 아직 참가하지 않은 폰을 위한 것이며 이미 승인된 멤버 연결을 바꾸지 않는다.

현재 소스의 동작을 읽어 확인한 제안이다. 이 문서 작성 중 서버 프로세스를 재시작하거나 이미 연결된 방을 갱신하지 않았다.
