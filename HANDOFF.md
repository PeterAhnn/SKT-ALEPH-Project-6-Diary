# T06 인수인계

정리일: 2026-09-30

## 1. 목표

「플랜두씨 다이어리 1 — 내 계획과 실제를 담는 앱」의 실제 DB·Plan/Do/See·공개 결과물·검증한 전체 커밋을 완성하고 T07 기준점을 보존한다. 공식 전체 설명·카드 1~5·제출 화면 대조는 [docs/TASK-READBACK.md](docs/TASK-READBACK.md)에 있다.

## 2. 현재 상태

Node.js 24 기본 HTTP/ES modules 앱, 실제 SQLite, Vercel API/Supabase PostgreSQL 저장 계층을 구현했다. 실사용 DB에는 자동 합성 seed가 없다. 로그인 기능 없이 공식 공개 안내를 첫 화면에 표시한다.

승인 원계획 **ALEPH 과제 진행·검증 정리**에 Task7·현재 완료4·실측 실행3을 저장했다. 실행은 T05 실제 AI 협업 구간이며 예상300분은 승인된 AI 추천이다. 원자료 초·반올림 분·원시 시각은 [승인 자료](records/user-approved-recommendation.json)에 보존했다. 원계획 집계는 7/4/0/3, 예상300·실제18·차이−282분이다.

승인 자료를 빈 Supabase 프로젝트 **yynsaokvquggrbdrmalr**로 옮겼고 이전 시점의 7표·모든 필드·export 동일성을 확인했다. [verification/cloud-transfer.json](verification/cloud-transfer.json)을 따른다. 회고/다음 계획 추가 뒤 최신 전체 수량은 [docs/FINAL-REPORT.md](docs/FINAL-REPORT.md)를 확인한다.

사용자가 고른 개선 **작업 전에 파일 읽기와 검사 실행 권한부터 확인한다**를 cloud UI로 저장하고 다음 계획 **ALEPH 남은 검증 마무리**(2026-10-01~02, 예상135분)에 연결했다. 다음 계획에는 아직 할 일이 없다. 전체 cloud 수량은 Plan2/history3/Task7/Execution3/completion4/receipt4/review1이다.

공개 저장소는 [PeterAhnn/SKT-ALEPH-Project-6-Diary](https://github.com/PeterAhnn/SKT-ALEPH-Project-6-Diary)이며 push·전체 커밋 확인 전이다. 첫 Vercel 운영 배포는 READY이고 [공개 URL](https://skt-aleph-project-6-diary.vercel.app)의 health에서 HTTP200·postgres·authentication:false를 확인했다. 새 공개 브라우저의 화면/자료 확인과 최종 소스 일치는 남아 있다.

## 3. 실행 명령

Node.js 24 이상이 필요하다. 외부 런타임 패키지 의존성은 없다.

    npm start
    npm test
    npm run check

기본 포트는 8006이다. .env의 Supabase URL/publishable 키가 있으면 PostgreSQL, 없으면 .data/diary.sqlite를 사용한다. 현재 승인 자료 SQLite 서버는 8006, PostgreSQL 검사 서버는 8008이다. 재개 시 실제 서버/포트 상태를 확인한다.

    node scripts/write-schema.mjs
    node scripts/transfer-to-cloud.mjs verify

스키마 생성은 실제 디스크 DB를 introspection한다. 이전 검증은 8006/8008의 7표·export 동일성을 검사한다. 추가 편집으로 DB가 달라졌다면 실패가 정상일 수 있고 자동 덮어쓰기를 하지 않는다. 승인 자료 가져오기를 다시 실행하려면 출처 해시와 현재 기록을 확인한다.

작업 폴더: C:\Users\Administrator\Desktop\SKT ALEPH\SKT-ALEPH\SKT-ALEPH-Project-6-Diary.

## 4. 통과 검사

- 로컬 자동 검사 27/27: 디스크 재시작, Plan 이력/충돌, 완료 중복/다시열기, Do 분리, 집계 경계/정렬, 삭제 복구, 다음 계획 단일 생성, 입력 거절, HTTP 안전성.
- 실제 PostgreSQL 익명 역할 35/35: RPC·중복/충돌·이력, 원시 테이블 쓰기/DELETE 제한, 잘못된 입력 거절. 최초 검사 [verify-postgres-result.json](db/verify-postgres-result.json)은 ROLLBACK 전후0건, 최적화 후 [verify-postgres-optimized-result.json](db/verify-postgres-optimized-result.json)은 실제 자료를 보존한35/35 결과다.
- Supabase security advisors 0건. 해당 검사 범위의 결과이며 모든 안전성 보증으로 확대하지 않는다.
- 승인 자료의 local/PG 7표 deep equality·ID/UTC 시각/버전/숫자 보존·한 파일 export 동일.
- 합성 UI 입력/완료/검색/상태 필터·See 기여 기록·삭제/복구 뒤 실행 유지·스크립트 모양 문자열의 문자 표시/미실행. 사용자 회고/다음 계획은 실제 cloud UI와 API 연결을 확인했다.

## 5. 남은 문제

최종 push/커밋, 새 인증 없는 브라우저 접근, 배포와 커밋 일치, 화면 폭, 공개 환경 비밀값/콘솔/네트워크 점검을 마쳐야 한다. 플랫폼 제출·접수·승인은 완료하지 않았다.

## 6. 다음 행동

1. 공개 브라우저에서 원계획·기여 기록·개선 연결·전체 내보내기를 다시 확인한다.
2. 공개 배포·최신 DB 계약·최종 소스를 검증하고 실제 전체 커밋 URL을 확정한다.
3. 남은 UI/공개 접근/안전성을 기록하고 [docs/SUBMISSION.md](docs/SUBMISSION.md)를 최종화한다. T07용 전체 export·계약·기준 커밋을 보존한다.

## 7. 건드리지 말 것

- 공식 수량·집계·날짜 규칙, 제출 항목명과 실제 소문자 전체 커밋 /commit/ URL.
- 승인 원자료·원본 초/시각/해시와 T05 동결 근거. AI 협업을 직접 공부 시간으로 바꾸지 않는다.
- T06 로그인 없음·정확한 공개 안내, Plan 불변 이력·실행 분리·DB 요청 중복 방지.
- .env, .data, .test-data, .vercel은 Git 제외. 키를 제품 화면·보고서·제출·Git에 넣지 않는다. service-role/secret 키를 사용하지 않는다.
- 기존 인증 내장 브라우저 우선. 공개 접근/반복 QA는 격리된 gstack 세션이며 개인 Chrome 탭/탭 그룹을 만들지 않는다.

