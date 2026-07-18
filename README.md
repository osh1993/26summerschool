# 2026 여름수련회 운영 시스템

Google Forms로 받은 참석 정보를 Google Sheets에서 정리하고, 조편성과 광주↔수련회장 차량 배치를 관리한 뒤 개인정보를 제거한 결과만 Vercel 정적 호스팅과 GitHub Wiki에 공시하는 프로젝트입니다.

## 구성

- `apps-script/`: Google Sheets에 연결하는 Apps Script
- `docs/`: Vercel로 배포하는 모바일 공시 대시보드
- `vercel.json`: Vercel CLI 정적 배포 설정(배포 대상 `docs/`, 배포 전 `npm run check` 검증 게이트)
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

## 배포 순서 (Vercel CLI)

배포는 GitHub가 아닌 **Vercel CLI**가 담당합니다. `docs/` 정적 사이트만 공개되며, 배포 전 `npm run check`가 개인정보·정원·중복 검증 게이트로 실행됩니다.

1. `apps-script/README.md`에 따라 Google Sheets와 Apps Script를 준비합니다.
2. Apps Script 웹앱 URL을 `docs/config.js`에 설정합니다.
3. `npm.cmd run check`로 공개 데이터 검사를 통과시킵니다.
4. Vercel CLI를 준비합니다. (최초 1회)
   ```powershell
   npm.cmd i -g vercel
   vercel login
   vercel link      # 프로젝트 이름은 26summerschool 권장 → 26summerschool.vercel.app
   ```
5. 배포합니다.
   ```powershell
   npm.cmd run deploy:preview   # 프리뷰 URL로 확인
   npm.cmd run deploy           # vercel --prod, 운영 배포
   ```
6. GitHub Wiki를 한 번 초기화한 뒤 `wiki/`의 Markdown을 Wiki 저장소에 게시합니다.

공개 대시보드: <https://26summerschool.vercel.app/>

> 프로덕션 URL이 위와 다르면 `PUBLIC_URL` 환경변수로 Wiki를 재생성합니다. 예: `PUBLIC_URL=https://<실제-도메인>/ npm.cmd run build:wiki` 후 Wiki에 push. `vercel.json`의 `github.enabled: false`로 Git 연동 자동 배포는 꺼져 있어 배포 시점은 CLI 실행으로만 제어됩니다.
>
> GitHub Wiki는 웹 UI에서 첫 페이지를 한 번 생성해야 `.wiki.git` 원격 저장소가 만들어집니다. 첫 페이지 생성 후 `wiki/`의 문서를 별도 Wiki 저장소에 push합니다.
