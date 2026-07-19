# 실운영 준비 런북 (샘플 → 실데이터 Go-Live)

이 문서는 샘플로 배포된 공개 대시보드를 **실제 수련회 데이터**로 전환하는 전체 순서다.
`[직접]` = 운영자가 Google 계정/브라우저에서 직접 수행(내가 대신 못 함). `[코드]` = 저장소에서 처리(이미 됨/명령 실행).

**아키텍처:** 입력·배정·게시는 Google Sheets + Apps Script, 웹(Vercel)은 읽기전용 공개 뷰 + 인증 내부 뷰. 개인정보는 Apps Script 서버에만 보관, 공개는 성 마스킹.

---

## STEP 1 — 운영 Google Sheet 생성 `[직접]`
1. 교회 관리 계정으로 새 Google Spreadsheet 생성(공개 안 함, 최소 인원만 편집).
2. Google Form(학생/교사 신청)을 이 시트에 응답 연결하거나, 명단은 Roster Import로 나중에 넣는다.

## STEP 2 — Apps Script 코드 설치 `[직접 + 코드]`
`00_Config.gs`~`07_RosterImport.gs`, `Core.js`, `appsscript.json` 총 10개를 시트의 Apps Script에 올린다.

### 방법 A: clasp (권장, 명령 한 줄로 push)
```powershell
npm.cmd i -g @google/clasp
clasp login                      # [직접] 구글 로그인(브라우저 승인)
```
1. 시트에서 `확장 프로그램 > Apps Script` 열기 → `프로젝트 설정(⚙️)`에서 **스크립트 ID** 복사.
2. 저장소에서:
   ```powershell
   copy apps-script\.clasp.json.example apps-script\.clasp.json
   ```
   `apps-script\.clasp.json`의 `scriptId`에 복사한 ID를 붙여넣는다. (이 파일은 git 무시됨)
3. push:
   ```powershell
   cd apps-script; clasp push        # tests/·README·package.json은 .claspignore로 제외됨
   ```
4. Apps Script 편집기에서 `appsscript.json`의 Advanced Drive Service 권한 승인.

### 방법 B: 수동 복사·붙여넣기
`확장 프로그램 > Apps Script`에서 파일 10개를 같은 이름으로 만들어 내용 붙여넣기(`tests/`·README·package.json은 제외).

## STEP 3 — 시트 초기화 & 연결 `[직접]`
1. 시트 새로고침 → 상단 **`수련회 운영`** 메뉴 생성 확인.
2. `1. 운영 시트 초기화` 실행(권한 승인). Participants/Groups/Rooms/Time_Slots/Vehicles 등 탭과 표준 7세션이 생성된다.
3. Form 응답 탭 이름을 `Settings`에 맞추고, `Form_Field_Map`에 질문↔필드 매핑 입력(상세: `apps-script/README.md` 2장).

## STEP 4 — 운영 데이터 입력·배정·검증 `[직접]`
1. `Settings`에 행사 정보·`GROUP_COUNT`·`ROOM_COUNT`.
2. Form 동기화 또는 `2-1/2-2 명단 가져오기`로 참석자 입력. 특성(적극성·외향성)·동의(`public_consent`)·`public_name`(선택) 확인.
3. `조편성 제안` 실행 → 교사(role=teacher)·부조장(sub_leader) 수동 배정.
4. `Rooms` 입력 후 방 배정(`Room_Assignments`), `Vehicles`/`Trips`/`Travel_Demands` 입력 후 차량 배정.
5. `게시 전 검증`으로 차단 오류(정원·성별·중복·미배정·실명유입)를 0으로 만든다.

## STEP 5 — 공개 스냅샷 게시 `[직접]`
`공개 스냅샷 게시` 실행 → 개인정보 제거된 v4 공개본이 원자적으로 활성화된다(실패해도 이전 정상본 유지).

## STEP 6 — 웹앱 배포 `[직접]`
1. Apps Script `배포 > 새 배포 > 웹 앱`.
2. 실행 사용자 = 나, 액세스 = **모든 사용자**(매니페스트 기본값). 배포.
3. 나온 `.../exec` URL 복사. (공개=doGet, 내부=doPost가 같은 URL)

## STEP 7 — 인증(내부 뷰) 설정 `[직접]`
전체 이름 열람용 공용 ID/PW를 서버에 저장한다(저장소엔 커밋 금지).
1. 비밀번호 해시 생성:
   ```powershell
   node scripts/hash-password.mjs      # 프롬프트에 비번 입력 → SHA-256 hex 출력
   ```
2. Apps Script `프로젝트 설정 > 스크립트 속성`에 추가:
   - `CAMP_INTERNAL_USER` = 공용 아이디(예: `camp-staff`)
   - `CAMP_INTERNAL_PW_HASH` = 위 hex(소문자)
   - `CAMP_INTERNAL_TOKEN_SECRET` = 임의의 긴 무작위 문자열(쓰기 토큰 서명 비밀키). **설정해야 `설정` 탭에서 웹 편집·저장이 활성화**된다. 미설정이면 읽기·내부 명단은 되지만 설정 저장은 잠긴다(안전 기본값).
3. 미설정 시 내부 탭은 데모 샘플로만 동작한다.
4. (선택) 로그인 후 공개 페이지 **`설정` 탭**에서 시트를 열지 않고도 운영 설정·조·방·차량·Form 매핑을 웹에서 편집·저장할 수 있다(토큰 비밀키 설정 시). 상세: `apps-script/README.md` 4-2장.
5. (선택) 같은 `설정` 탭의 **참석자 관리** 서브섹션에서 참석자를 웹에서 추가·수정·비활성할 수 있다. **주의: 이 화면은 실명·연락처(PII)를 인증 브라우저에 직접 표시**하므로 공용 PC·공유 화면에서 열지 않는다. 신규는 `public_consent=FALSE`로 시작하고, 비활성은 삭제가 아니라 `active=FALSE`이며 배정은 보존된다. 모든 변경은 `Change_Log`에 남고(변경자 기록, 민감필드는 `[REDACTED]`), 참석자 데이터는 정적 파일로 저장되지 않는다. 상세: `apps-script/README.md` 4-3장.

## STEP 8 — config.js 연결 + Vercel 재배포 `[직접 + 코드]`
`docs/config.js`에 URL 입력(비밀번호 아님, 커밋 가능):
```js
window.CAMP_CONFIG = Object.freeze({
  apiUrl: "https://script.google.com/macros/s/배포ID/exec?view=public",
  internalApiUrl: "https://script.google.com/macros/s/배포ID/exec"
});
```
그다음:
```powershell
npm.cmd run check      # 개인정보·정원 검증 게이트
npm.cmd run deploy     # Vercel 운영 배포
```

## STEP 9 — Go-Live 검증 `[코드/직접]`
- 공개 URL: 조 테이블·방배정·차량 버킷이 **실데이터**로 표시, 이름은 성 마스킹, 페이지 소스에 전체 실명 없음.
- 내부 탭: 올바른 ID/PW → 전체 이름·교사/스탭·방배정 표시, 오답 → 거부.
- 설정 탭(토큰 비밀키 설정 시): 로그인 후 설정/조/방/차량/매핑을 웹에서 편집·저장 → 시트에 반영. 미설정이면 "토큰 비밀키 미설정" 안내로 저장 비활성.
- 참석자 관리(토큰 비밀키 설정 시): 로그인 후 참석자 추가/수정/비활성 → `Participants`/`Participant_Private`/`Change_Log`에 반영. `participant_id`/`public_id` 불변, 비활성은 `active=FALSE`. 공개 페이지 소스에는 이 PII가 나타나지 않음(인증 화면에서만 표시).
- Wiki 링크(있으면) Vercel URL 일치.

---

## 개인정보 원칙(항상)
- 공개 저장소·공개 JSON에 실명·전화·생년월일·보호자연락처·차량번호판 금지.
- `docs/data/sample*.json`은 **합성 데모 전용** — 실데이터로 덮어써 커밋하지 말 것(실데이터는 Apps Script에서만).
- 비밀번호 원문·해시는 Script Property에만. `.clasp.json`·`.env*`는 git 무시.
