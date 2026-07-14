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

## 3. 운영 데이터 입력 순서

1. `Settings`에서 행사 ID/명, 시작일·종료일, 조 수를 설정한다.
2. `Locations`에 내부 장소명과 공개 라벨을 나눠 입력한다. 웹에 보낼 장소만 `public_allowed=TRUE`로 둔다.
3. `Groups`의 목표/최소/최대 인원을 입력한다.
4. 필요하면 `Relations`에 함께/분리 제약을 입력하고 운영자 고정 배정은 `locked=TRUE` 또는 `assignment_source=manual`로 둔다.
5. `Vehicles`, `Vehicle_Availability`, `Trips`, `Travel_Demands`를 입력한다. 정원은 운전자 포함 전체 정원이다.
6. 메뉴에서 Form 동기화 → 조편성 제안 → 차량 수요 배정 → 게시 전 검증 순서로 실행한다.

조편성과 차량배정은 제안이다. 수동/잠금 행을 보존하며, 충족할 수 없는 제약과 미배정 수요는 `Validation`에 남긴다. 동반 인원은 `party_size`로 뭉치지 말고 각 사람을 참가자로 등록해야 공개 명단과 좌석 수가 일치한다.

## 4. 공개 스냅샷과 Web App 배포

1. `수련회 운영 > 5. 게시 전 검증`에서 차단 오류를 0으로 만든다.
2. `6. 공개 스냅샷 게시`를 실행한다.
3. Apps Script의 `배포 > 새 배포 > 웹 앱`을 선택한다.
4. 실행 사용자는 배포자, 액세스는 공개 페이지에서 읽을 수 있는 범위로 설정한다.
5. 배포 URL 뒤에 `?view=public`을 붙여 JSON을 확인한다.

예: `https://script.google.com/macros/s/배포식별자/exec?view=public`

URL 자체는 이 저장소에 커밋하지 말고 GitHub Pages의 환경/설정 파일에 별도로 주입한다. `view=public` 이외의 요청은 내부 시트나 범위를 조회할 수 없으며 오류 응답에도 스택·시트 정보가 없다.

게시 시 후보를 먼저 `active=FALSE` 상태의 URL-safe Base64 청크로 전부 저장한다. 청크 수·연속 인덱스·SHA-256·JSON 역직렬화·공개 계약을 다시 검증한 뒤 `ACTIVE_PUBLIC_PUBLISH_ID` Document Property 하나만 원자적으로 전환한다. `doGet`은 이 포인터만 읽으므로 저장·검증·포인터 전환 어느 단계가 실패해도 이전 정상 스냅샷이 계속 제공된다. `Public_Export.active`는 후보 저장 상태를 나타내는 레거시 호환 열이며 활성 여부의 기준은 포인터다.

## 5. 보안·개인정보 운영

- Google Spreadsheet와 Apps Script 편집 권한은 최소 운영자에게만 부여한다.
- 공개 저장소/Wiki에 Form 원본, Sheet ID/URL, 전화번호, 생년월일, 보호자 연락처, 상세주소, 관계·성향, 자유서술을 넣지 않는다.
- 공개 이름 동의가 철회되면 해당 배정을 수정한 뒤 즉시 새 스냅샷을 게시한다. 필요하면 `Public_Export`의 과거 비활성 행도 운영자가 삭제한다.
- `public_id`는 내부 ID를 해시한 값이 아니라 행사별 독립 난수이며 다른 행사에서 재사용하지 않는다.
- GitHub Pages는 JSON 값을 `innerHTML`이 아닌 `textContent`로 렌더링한다.
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
- `Validation`의 blocking 오류가 0
- `doGet?view=public`에 전화번호·실명 원본·내부 ID·상세주소가 없음
- GitHub Pages에 전체 정원(운전자 포함)과 남은 승객 좌석을 구분 표시함
