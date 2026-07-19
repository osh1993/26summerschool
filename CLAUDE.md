## 하네스: 여름수련회 운영

**목표:** Google Forms/Sheets 입력을 바탕으로 균형 있는 조편성과 2박 3일 차량 이동 배치를 관리하고, 개인정보를 제거한 결과를 Vercel 정적 호스팅과 GitHub Wiki에 공시한다.

**트리거:** 수련회 참석자, 조편성, 차량, 이동 수요, Google Forms/Sheets 연동, 공시 화면 또는 GitHub Wiki 관련 작업 요청 시 `camp-operations-orchestrator` 스킬을 사용하라. 단순 질문은 직접 응답 가능하다.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-07-14 | 초기 하네스 구성 | 전체 | 여름수련회 조편성·차량배치·공시 자동화 구축 |
| 2026-07-14 | 명단 일괄 가져오기(Roster Import) 추가 | apps-script/07_RosterImport.gs, Core.js, tests, README | 엑셀·구글시트 URL로 참석자 명단 upsert 요청 |
| 2026-07-16 | 배포를 GitHub Pages → Vercel CLI로 전환 | vercel.json, .vercelignore, package.json, README, wiki/*, scripts/build-wiki.mjs, camp-publisher, camp-qa, camp-public-dashboard, camp-operations-orchestrator | GitHub가 아닌 Vercel CLI 배포 요청 (Wiki는 유지) |
| 2026-07-19 | 쓰기 토큰 무효화 스위치 + TTL 30분(O1), 관리자 웹앱 Phase C(조/방/차량 배정 편집) | apps-script/Core.js, 06_PublicApi.gs, 00_Config.gs, tests, docs/*, README, SETUP | PII 노출창 축소·즉시 무효화 수단 + 웹에서 배정 배정·이동·해제(저장 시 무결성 검증) |
