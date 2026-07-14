# 2026 여름수련회 운영 시스템

Google Forms로 받은 참석 정보를 Google Sheets에서 정리하고, 조편성과 광주↔수련회장 차량 배치를 관리한 뒤 개인정보를 제거한 결과만 GitHub Pages와 Wiki에 공시하는 프로젝트입니다.

## 구성

- `apps-script/`: Google Sheets에 연결하는 Apps Script
- `docs/`: GitHub Pages용 모바일 공시 대시보드
- `wiki/`: GitHub Wiki에 게시할 운영 문서와 정적 요약
- `scripts/`: 공개 데이터 개인정보·정원·중복 검증과 Wiki 요약 생성
- `.claude/`: 조편성·차량배치·게시·QA 하네스

## 안전 원칙

이 저장소는 공개 저장소입니다. 원본 Google Form, 엑셀, 실명, 전화번호, 생년월일, 보호자 연락처, 자유서술 응답, 차량 번호판은 커밋하지 않습니다. 공개 페이지는 행사별 무작위 `public_id`와 운영자가 승인한 `public_name`만 사용합니다.

## 로컬 확인

```powershell
npm.cmd run check
python -m http.server 4173 --directory docs
```

브라우저에서 `http://localhost:4173`을 엽니다.

## 배포 순서

1. `apps-script/README.md`에 따라 Google Sheets와 Apps Script를 준비합니다.
2. Apps Script 웹앱 URL을 `docs/config.js`에 설정합니다.
3. `npm.cmd run check`로 공개 데이터 검사를 통과시킵니다.
4. GitHub Pages 게시 원본을 `main` 브랜치의 `/docs`로 설정합니다.
5. GitHub Wiki를 한 번 초기화한 뒤 `wiki/`의 Markdown을 Wiki 저장소에 게시합니다.

공개 대시보드: <https://osh1993.github.io/26summerschool/>

> GitHub Wiki는 웹 UI에서 첫 페이지를 한 번 생성해야 `.wiki.git` 원격 저장소가 만들어집니다. 첫 페이지 생성 후 `wiki/`의 문서를 별도 Wiki 저장소에 push합니다.
