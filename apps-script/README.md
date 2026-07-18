# Google Sheets 바운드 Apps Script 설치·운영

이 디렉터리는 수련회 참가자·조편성·차량배치를 관리하는 Google Spreadsheet에 **바운드된 Apps Script**로 설치한다. 코드에는 실제 Spreadsheet ID/URL이나 참가자 개인정보가 없다.

## 구성

- `00_Config.gs`: 탭/헤더/기본 설정 계약
- `01_Sheets.gs`: 메뉴와 운영 시트 초기화
- `02_FormSync.gs`: Google Forms 원본 응답 증분 정규화, 행사별 공개 ID 생성
- `03_Grouping.gs`: 잠금·수동 배정을 보존하는 균형 조편성 제안
- `04_Dispatch.gs`: 등록된 운행/차량 가용시간에 이동 수요 배정
- `05_Validation.gs`: 내부 모델, 공개 동의, 장소 허용 검증
- `06_PublicApi.gs`: 검증된 마지막 정상 스냅샷 게시와 `doGet(view=public)`
- `Core.js`: Apps Script/Node 공용 순수 검증 로직
- `tests/core.test.js`: 정원, 중복, 공개 허용목록, 개인정보 회귀 테스트

## 1. 설치

1. Google Forms 응답을 받을 운영용 Google Spreadsheet를 교회 관리 계정으로 만든다.
2. `확장 프로그램 > Apps Script`를 연다.
3. 이 디렉터리의 `.gs`, `Core.js`, `appsscript.json` 내용을 같은 이름의 Apps Script 파일로 복사한다. `clasp`를 사용한다면 이 디렉터리를 프로젝트 루트로 설정해 push할 수 있다.
4. 저장 후 Spreadsheet를 새로고침한다.
5. 상단 메뉴 `수련회 운영 > 1. 운영 시트 초기화`를 한 번 실행하고 권한을 승인한다.

초기화는 운영 탭의 기존 데이터를 덮어쓰지 않는다. 헤더가 계약과 다르면 데이터 보호를 위해 중단한다.

## 2. Forms 연결과 필드 매핑

학생/교사 Form 응답 탭 이름을 기본값 `Form_Raw_Students`, `Form_Raw_Staff`로 맞추거나 `Settings`에서 변경한다. 원본 탭은 사람이 수정하지 않는다.

`Form_Field_Map`에 Form의 실제 질문 헤더를 정규 필드로 매핑한다.

| source_sheet | source_header | normalized_field | required | active |
|---|---|---|---|---|
| Form_Raw_Students | 이름 질문의 실제 헤더 | legal_name | TRUE | TRUE |
| Form_Raw_Students | 소속 질문의 실제 헤더 | campus | TRUE | TRUE |
| Form_Raw_Students | 학년 질문의 실제 헤더 | grade_band | TRUE | TRUE |
| Form_Raw_Students | 적극성 질문의 실제 헤더 | engagement_score | FALSE | TRUE |
| Form_Raw_Students | 전화번호 질문의 실제 헤더 | phone | FALSE | TRUE |

지원하는 민감 필드는 `birth_date`, `phone`, `guardian_phone`, `insurance_status`, `private_note`, `free_text`이며 `Participant_Private`에만 저장된다. 새 응답 동기화 후 `Participants.public_consent`와 `public_name`은 자동 공개되지 않는다. 운영자가 동의를 확인한 뒤 승인 게시명을 입력해야 한다.

동기화 커서는 `Settings.LAST_SYNC_ROW_*`에 저장된다. 원본 응답 행을 삽입·삭제한 경우 커서를 임의 수정하지 말고 먼저 백업한 뒤 관리자 검토를 거친다.

## 2-1. 명단 파일 일괄 가져오기(Roster Import)

Google Forms 외에, 이미 정리된 참석자 명단을 **다른 Google Sheets URL** 또는 **Drive의 엑셀(.xlsx) 파일**로 받아 `Participants`(+`Participant_Private`)에 병합(upsert)할 수 있다. 상세 계약은 `_workspace/07_data_architect_roster_import.md`를 따른다.

### 매핑 설정

명단 파일의 헤더는 자유 형식이므로, `Form_Field_Map` 탭에 `source_sheet=Roster_Import` 행으로 매핑을 등록한다. Form 매핑과 같은 탭·같은 정규 필드 어휘를 재사용한다.

| source_sheet | source_header | normalized_field | required | active |
|---|---|---|---|---|
| Roster_Import | 명단의 성명 헤더 | legal_name | TRUE | TRUE |
| Roster_Import | 명단의 구분 헤더 | person_type | FALSE | TRUE |
| Roster_Import | 명단의 소속 헤더 | campus | TRUE | TRUE |
| Roster_Import | 명단의 학년 헤더 | grade_band | FALSE | TRUE |
| Roster_Import | 명단의 연락처 헤더 | phone | FALSE | TRUE |

### 실행 순서

1. 메뉴 `수련회 운영 > 2-1. 명단 파일 가져오기(미리보기)`를 실행한다.
2. 소스 종류(`1`=Sheets URL, `2`=Drive xlsx 파일 ID), 대상 탭 이름, 소스 식별자를 프롬프트로 입력한다. **URL/파일 ID는 시트에 저장하지 않는다.**
3. 미리보기 결과(신규/갱신/충돌/동명이인 보류/건너뜀/명단 누락 건수)와 `Validation` 탭의 상세 코드를 확인한다. 미리보기는 시트를 변경하지 않는다.
4. 이상이 없으면 `2-2. 명단 가져오기 반영`을 실행한다. 기본은 **빈 칸만 채우고** 기존 값과 다르면 `ROSTER_FIELD_CONFLICT`로 보고만 한다. 프롬프트에 `OVERWRITE`를 입력하면 관리 필드를 명단 값으로 덮어쓴다.

### 안전 규칙

- 신규 참가자는 `participant_id`/`public_id`를 자동 발급하지만 `public_consent`는 항상 `FALSE`, `public_name`은 빈 값이다. 공개 명단에는 운영자 동의·승인 후에만 노출된다.
- `public_id`, `public_name`, `public_consent`, `active`, `source_response_id`는 가져오기가 절대 덮어쓰지 않는다. 조·차량의 수동/잠금 배정도 건드리지 않는다.
- 동명이인 등 매칭 키가 여러 명과 겹치면 병합하지 않고 `ROSTER_AMBIGUOUS_MATCH`로 해당 행만 건너뛴다. 운영자가 수동 확인한다.
- 명단에 없는 기존 활성 참가자는 자동 비활성화하지 않고 `ROSTER_MISSING_EXISTING` 경고로만 보고한다(명단은 부분 스냅샷일 수 있다).
- `phone`, `birth_date` 등 민감 필드는 `Participant_Private`로만 라우팅되며, `Change_Log`에는 원문 대신 `[REDACTED]`만 남긴다.
- 매칭 키는 `이름+구분(person_type)+캠퍼스`이며, 재실행 시 `source_response_id='roster_import:<키>'` 앵커로 idempotent하게 동작한다.

### Drive xlsx 변환과 권한

xlsx 소스는 Advanced Drive Service(`Drive` v2)로 임시 Google Sheets로 변환해 읽고 즉시 폐기한다. 이를 위해 `appsscript.json`에 Advanced Drive Service와 `drive` 스코프가 추가되어 있다. 최초 실행 시 권한 재승인이 필요하며, 웹앱을 재배포해야 새 스코프가 반영된다. 조직 정책상 Advanced Drive Service를 켤 수 없으면, 운영자가 xlsx를 Google Sheets로 수동 변환한 뒤 소스 (A) URL 방식으로 제출한다.

## 3. 운영 데이터 입력 순서

1. `Settings`에서 행사 ID/명, 시작일·종료일, 조 수를 설정한다.
2. `Locations`에 내부 장소명과 공개 라벨을 나눠 입력한다. 웹에 보낼 장소만 `public_allowed=TRUE`로 둔다.
3. `Groups`의 목표/최소/최대 인원을 입력한다.
4. 필요하면 `Relations`에 함께/분리 제약을 입력하고 운영자 고정 배정은 `locked=TRUE` 또는 `assignment_source=manual`로 둔다.
5. `Vehicles`, `Vehicle_Availability`, `Trips`, `Travel_Demands`를 입력한다. 정원은 운전자 포함 전체 정원이다.
6. 메뉴에서 Form 동기화 → 조편성 제안 → 차량 수요 배정 → 게시 전 검증 순서로 실행한다.

조편성과 차량배정은 제안이다. 수동/잠금 행을 보존하며, 충족할 수 없는 제약과 미배정 수요는 `Validation`에 남긴다. 동반 인원은 `party_size`로 뭉치지 말고 각 사람을 참가자로 등록해야 공개 명단과 좌석 수가 일치한다.

## 3-1. 방배정(숙소) 입력·검증

방 정보와 방 배정은 **운영자가 시트에서 수동 입력**한다. Apps Script는 자동 배정 알고리즘을 제공하지 않고, 정원·성별·중복·참조·미배정을 **검증만** 한다.

### `Rooms` 탭 입력

| 열 | 설명 |
|---|---|
| `room_id` | 방 식별자(예: `R-101`). 배정에서 참조하는 키 |
| `display_name` | 공개/내부 화면에 보일 방 이름(예: `101호`) |
| `capacity` | 정수 정원 |
| `floor` | 층 표시값(예: `1`). 화면에 `N층`으로 표기 |
| `gender_scope` | `male`(남) · `female`(여) · `mixed`(혼성, 성별 제약 없음) |
| `active` | `FALSE`면 화면·검증 대상에서 제외(창고 등 운영 전용 방) |
| `private_note` | **비공개 메모**. 공개/내부 스냅샷에 절대 나가지 않음 |

- `수련회 운영 > 4-1. 방 개수 맞추기(Settings 기준)`는 `Settings.ROOM_COUNT`(기본 8)에 맞춰 활성 방 행 수를 정렬한다. 기존 방 이름·정원·성별은 보존하고, 배정이 있는 방은 비활성화하지 않는다.

### `Room_Assignments` 탭 입력

| 열 | 설명 |
|---|---|
| `room_id` | `Rooms`의 방 식별자 |
| `participant_id` | `Participants`의 참가자 식별자 |
| `locked` | 재배정 보호 표시 |
| `assignment_source` | 기본 `manual` |

한 참가자는 한 방에만 배정한다. 학생·교사·스탭 모두 방 배정 대상이며, 화면에는 `person_type`(학생/교사/스탭)이 함께 표시된다.

### 방배정 검증

`수련회 운영 > 4-2. 방배정 검증`을 실행하면 결과가 `Validation` 탭에 기록된다. 게시 전 검증(5)에도 통합되어, 아래 **차단** 이슈가 하나라도 있으면 공개 스냅샷을 게시하지 않는다.

| 코드 | 의미 | 등급 |
|---|---|---|
| `ROOM_OVER_CAPACITY` | 배정 인원이 정원을 초과 | 차단 |
| `ROOM_GENDER_MISMATCH` | 성별 방(male/female)에 다른 성별 배정 | 차단 |
| `ROOM_DUPLICATE_ASSIGNMENT` | 한 참가자가 2개 이상 방에 배정 | 차단 |
| `ROOM_UNKNOWN_REF` | 없는 방/참가자 참조 | 차단 |
| `ROOM_UNASSIGNED` | 활성 참가자가 어떤 방에도 미배정 | 경고 |
| `ROOM_INACTIVE_TARGET` | 비활성(`active=FALSE`) 방에 배정 | 경고 |

공개 화면의 방 카드는 성 마스킹된 표시명만 보여주고, 인증 내부 뷰(4-1)에서만 전체 이름을 표시한다.

## 4. 공개 스냅샷과 Web App 배포

1. `수련회 운영 > 5. 게시 전 검증`에서 차단 오류를 0으로 만든다.
2. `6. 공개 스냅샷 게시`를 실행한다.
3. Apps Script의 `배포 > 새 배포 > 웹 앱`을 선택한다.
4. 실행 사용자는 배포자, 액세스는 공개 페이지에서 읽을 수 있는 범위로 설정한다.
5. 배포 URL 뒤에 `?view=public`을 붙여 JSON을 확인한다.

예: `https://script.google.com/macros/s/배포식별자/exec?view=public`

**시간 버킷 규칙:** 공개 스냅샷은 각 운행 출발 시각(`Trips.depart_at`)에서 `time_bucket`을 파생 표시한다 — 로컬 벽시계 기준 `00:00–11:59=오전(morning)`·`12:00–17:59=오후(afternoon)`·`18:00–23:59=밤(night)`. 공개 화면은 이 오전/오후/밤 배지·필터를 쓰고, 내부 정밀 ISO 시각(`depart_at`)은 변경하지 않으며 내부 뷰에서 정밀 날짜·시각으로 표시한다.

URL 자체는 이 저장소에 커밋하지 말고 정적 사이트의 설정 파일(`docs/config.js`)에 별도로 주입한다. `view=public` 이외의 요청은 내부 시트나 범위를 조회할 수 없으며 오류 응답에도 스택·시트 정보가 없다.

게시 시 후보를 먼저 `active=FALSE` 상태의 URL-safe Base64 청크로 전부 저장한다. 청크 수·연속 인덱스·SHA-256·JSON 역직렬화·공개 계약을 다시 검증한 뒤 `ACTIVE_PUBLIC_PUBLISH_ID` Document Property 하나만 원자적으로 전환한다. `doGet`은 이 포인터만 읽으므로 저장·검증·포인터 전환 어느 단계가 실패해도 이전 정상 스냅샷이 계속 제공된다. `Public_Export.active`는 후보 저장 상태를 나타내는 레거시 호환 열이며 활성 여부의 기준은 포인터다.

## 4-1. 인증 내부 뷰(전체 이름) 설정

공개 페이지는 성 마스킹된 표시명(`홍○○`)만 보여준다. 교역자·교사가 전체 이름과 교사/스탭 명단을 보려면 **공용 아이디/비밀번호 1세트**로 인증하는 내부 뷰(`doPost`)를 쓴다. 개인정보는 Apps Script 서버에서 검증 후에만 반환되며 정적 파일로 저장하지 않는다.

### Script Property 설정(비밀번호는 저장소에 커밋 금지)

1. Apps Script 편집기에서 `프로젝트 설정(톱니바퀴) > 스크립트 속성`을 연다.
2. 아래 두 속성을 추가한다. **평문 비밀번호는 어디에도 커밋하지 않는다.**

| 속성 이름 | 값 |
|---|---|
| `CAMP_INTERNAL_USER` | 공용 아이디(평문, 예: `camp-staff`) |
| `CAMP_INTERNAL_PW_HASH` | 비밀번호의 **SHA-256 hex 문자열**(소문자) |

3. 비밀번호 해시는 아래처럼 만든다. 원문 비밀번호는 저장하지 말고 이 hex 값만 속성에 넣는다.
   - PowerShell 예:
     ```powershell
     $pw = "여기에_비밀번호"
     -join ([System.Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($pw)) | ForEach-Object { $_.ToString("x2") })
     ```
   - 또는 Apps Script 임시 실행:
     ```javascript
     function printHash() { Logger.log(sha256Hex_('여기에_비밀번호')); }
     ```
4. 배포는 공개 뷰와 같은 웹앱 배포를 재사용한다. `doPost`가 같은 `/exec` URL로 들어온다. 새 코드 반영을 위해 **새 버전으로 재배포**한다.

### 동작

- 클라이언트가 `{ user, password }`를 `/exec`로 POST하면, 서버가 `CampCore.verifyInternalCredential`로 아이디 일치 + 비밀번호 SHA-256 상수시간 비교를 확인한다.
- 성공 시에만 `internal-snapshot/v3`(공개 v4 구조 + 각 member `full_name` + 최상위 `teachers[]`/`staff[]` + `rooms[]`·`trips[]` 탑승자의 `full_name`)를 반환한다. 실패·미설정·오류 시에는 `{ "error": "unauthorized" }` 또는 `{ "error": "temporarily_unavailable" }`만 반환하며 힌트/스택이 없다.
- 정적 사이트는 `docs/config.js`의 `internalApiUrl`에 이 `/exec` 주소를 넣는다(URL은 비밀키가 아니지만, **비밀번호는 절대 config.js에 넣지 않는다**). 미설정 시 내부 탭은 합성 샘플(`docs/data/sample-internal.json`)로 화면만 시연한다.
- 브라우저는 자격증명을 저장하지 않고, 응답 스냅샷만 `sessionStorage`에 임시 보관하며 개인정보는 화면에만 표시한다.

## 5. 보안·개인정보 운영

- Google Spreadsheet와 Apps Script 편집 권한은 최소 운영자에게만 부여한다.
- 공개 저장소/Wiki에 Form 원본, Sheet ID/URL, 전화번호, 생년월일, 보호자 연락처, 상세주소, 관계·성향, 자유서술을 넣지 않는다.
- 공개 이름 동의가 철회되면 해당 배정을 수정한 뒤 즉시 새 스냅샷을 게시한다. 필요하면 `Public_Export`의 과거 비활성 행도 운영자가 삭제한다.
- `public_id`는 내부 ID를 해시한 값이 아니라 행사별 독립 난수이며 다른 행사에서 재사용하지 않는다.
- 공개 대시보드는 JSON 값을 `innerHTML`이 아닌 `textContent`로 렌더링한다.
- 집결 상세주소는 공개 JSON 대신 접근 통제된 별도 공지 채널을 사용한다.

## 6. 로컬 순수 로직 테스트

Node.js가 설치된 환경에서 별도 패키지 설치 없이 실행한다.

```powershell
node apps-script/tests/core.test.js
```

테스트는 정원 경계/초과, 조 최소 인원 차단, 누락 참가자 참조, 묶음 내부 관계 충돌, 공개 허용목록, 개인정보 유출, 경고 공시, 잔여좌석 계산을 확인한다. 또한 후보 저장·읽기·검증·원자 포인터 전환에 실패를 주입해 매 단계에서 이전 정상 포인터가 보존되는지 검사한다. Apps Script 서비스와 실제 Sheet 연결은 복제본 Spreadsheet에서 메뉴 순서대로 별도 통합 테스트한다.

## 7. 배포 전 체크리스트

- `Settings.EVENT_START_DATE`, `EVENT_END_DATE`가 `YYYY-MM-DD`로 입력됨
- 모든 공개 대상에게 `public_consent=TRUE`, 승인된 `public_name`이 있음
- 공개 운행의 세 장소가 모두 `public_allowed=TRUE`이고 공개 라벨을 가짐
- 운전자 포함 정원 초과, 차량/운전자/승객 시간 중복이 없음
- 방 정원 초과, 성별 방 위반, 한 참가자 다중 방 배정, 없는 방/참가자 참조가 없음(방배정 검증 blocking 0)
- `Validation`의 blocking 오류가 0
- `doGet?view=public`에 전화번호·실명 원본·내부 ID·상세주소가 없음(방 카드 표시명도 성 마스킹)
- 공개 대시보드에 전체 정원(운전자 포함)과 남은 승객 좌석을 구분 표시함
