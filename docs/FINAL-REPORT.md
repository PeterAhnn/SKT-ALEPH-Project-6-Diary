# T06 구현·검증 보고서

기준일: 2026-09-30. 검토·보관용이며 공식 필수 첨부물이 아니다. 원문 요구와 출처는 [ASSIGNMENT.md](ASSIGNMENT.md), 전체 설명·5단계 대조는 [TASK-READBACK.md](TASK-READBACK.md)를 따른다. 아래 완료와 남은 검사를 구분한다.

## 목적과 구현

ALEPH 공부·과제 진행의 계획과 실제 기록을 연결하고 예상/실제 차이와 막힌 이유를 확인해 다음 계획에 반영하는 한국어 앱을 만들었다. Node.js24 기본 HTTP/ES modules, 실제 디스크 SQLite, Vercel Node API·Supabase PostgreSQL을 사용한다. 기술 제품과 분 단위는 구현 선택이다.

Plan은 같은 ID의 초기·수정 스냅샷을 보존한다. Task는 마감·우선순위·태그·예상 분, 완료·다시 열기·삭제·복구와 검색/필터/안정 정렬을 제공한다. Do는 실행과 Plan 값을 분리한다. See 지표는 계산에 기여한 Task/Execution을 열 수 있고, 개선 원문과 다음 Plan은 단일 연결로 저장한다. 전체 자료는 JSON파일 한 개로 내보낸다.

T06에는 인증 기능을 붙이지 않았다. 첫 화면의 공식 안내:

> 지금은 로그인이 없어 링크를 아는 사람은 누구나 볼 수 있습니다. 남이 봐도 괜찮은 내용만 넣으세요

## 승인 자료·집계·개선 연결

[user-approved-recommendation.json](../records/user-approved-recommendation.json)은 사용자가 적용을 승인한 이전 과제 근거·추천 계획·할 일·실측 AI 협업 실행의 정본이다. 예상300분은 승인된 AI 추천이며 과거 사용자 계획값이나 실측 시간이 아니다. 생성·수정·완료 처리 시각은 현재 가져오기 시점으로 기록하고 과거로 바꾸지 않았다.

| 원계획의 항목 | 실제 확인값 | 해석 |
|---|---:|---|
| Plan / 초기·수정 이력 | 1 / 2 | 같은 ID의 초기·수정 스냅샷 |
| 삭제되지 않은 Task / 현재 완료 | 7 / 4 | 현재 상태 집계 |
| 실행 / 막힌 Task | 3 / 3 | 실측 AI 협업 실행, 막힌 Task 한 번씩 |
| 지연 | 0 | 2026-09-30 서울 오늘 기준 |
| 예상 / 실제 / 차이 | 300 / 18 / −282분 | 전체 예상과 근거 있는 실행 합계의 비교 |

−282분은 모든 작업이 그만큼 빨리 끝났다는 결론이 아니다. 실측 실행3건만 합산했으며 미실측 작업이나 직접 공부 시간을 채우지 않았다. T02 본인 플레이·T04 현재 제출 상태 재확인·T06 남은 검증은 미완료로 유지했다.

| 실측 AI 협업 | 원자료 초 | 정수 분 |
|---|---:|---:|
| T05 R01 A | 130.9693742 | 2 |
| T05 R02 A | 53.054 | 1 |
| T05 R02 B | 904.712 | 15 |

반올림은 Math.round(원자료 초/60)이다. 원본 시각·초·소수 정밀도·출처 해시를 정본과 앱 메모에 보존했다. DB 시각은 UTC ISO 밀리초 문자열, 표시와 지연 계산은 Asia/Seoul이다. 이3건은 실제 도구 수행 기록이며 합성 시험이나 학생 직접 공부 시간으로 쓰지 않는다.

사용자가 선택한 개선 **작업 전에 파일 읽기와 검사 실행 권한부터 확인한다**를 실제 cloud UI에서 회고에 저장하고 다음 계획 **ALEPH 남은 검증 마무리**(2026-10-01~02, 예상135분)에 연결했다. 135분은 남은 Task의 60+15+60분이다. 다음 Plan에는 아직 Task가 없어 그 Plan의 See는0이다. 원계획의7/4/0/3·300/18/−282분은 유지됐다.

| 연결 | 실제 ID |
|---|---|
| 원계획 | ac9cad6d-c16c-4c20-b890-eac7466e6ad2 |
| 회고 | 0ce0ee26-835e-4d5e-837c-ccbbf146b7b0 |
| 다음 계획 | a38f2070-8f88-413e-b132-58d75ad8f1ae |

API에서 개선 원문·nextPlan.source_review_id·review.next_plan_id의 일치를 확인했다. 최신 전체 cloud 수량은 Plan2/history3/Task7/Execution3/completion4/receipt4/review1이다.

## 실제 검사·근거

| 검사 | 기대값 | 실제 결과·근거 |
|---|---|---|
| 로컬 자동 검사 | 이력·충돌·중복·분리·집계·복구·내보내기·Vercel 본문 경계 | npm test **27/27 PASS**, [tests](../tests/) store13·API7·core6·Vercel1 |
| 실제 PG 익명 역할 | RPC·원시 입력/권한·불변 이력 | **35/35 PASS**, [SQL](../db/verify-postgres.sql)·[최초 결과](../db/verify-postgres-result.json), fixture ROLLBACK 전후7표0건 |
| PG 최적화 후 재검사 | 실제 자료 그대로·gate 의미 유지 | **35/35 PASS**, [최적화 결과](../db/verify-postgres-optimized-result.json), 기존7표 정확히 보존·ROLLBACK |
| Supabase advisors | security 발견사항0 | security **0건**, performance 경고0·INFO unused-index3건; FK용 인덱스 유지 |
| 승인 자료 cloud 이전 | 기존 자료 덮어쓰기 없이 모든 필드 유지 | 빈 DB 검사/table lock/한 트랜잭션, local/PG7배열 deep equality PASS, [cloud-transfer.json](../verification/cloud-transfer.json) |
| 한 파일 내보내기 | 전체7표·ID/날짜/값/단위 일치 | local/PG export 데이터 동일 PASS; 생성 시각만 대조 제외 |
| 합성 UI | 폼·완료·검색·상태 필터 일치 | Plan/Task/Execution 실제 입력·완료·검색/필터 확인 |
| 합성 See·기여 기록 | 1/1/0/1·예상20/실제25/차이+5 | 화면값과 클릭한 기여 기록 일치 |
| 합성 삭제/복구 | 연결 실행 유지 | UI 삭제·복구 후 실행1건 보존 |
| 합성 XSS | 스크립트 모양 문자열 문자 표시·미실행 | HTTP JSON/DOM 문자 표시·실행 표식 없음·CSP 확인 |
| 사용자 개선 | 원문·양방향 연결 유지 | 실제 cloud UI 저장과 live API 대조 통과 |
| 공개 무인증 GET | 9요청·HTTP200·로그인 전환 없음 | state2회·전체 export·정적4파일 SHA 동일, [public-verification.json](../verification/public-verification.json) |
| 실제 화면과 모바일 | 실제 집계·기여 기록·화면 넘침 없음 | [See 화면](../verification/see-desktop.png)·[375px 모바일](../verification/see-mobile.png)·[실행 기여 기록](../verification/actual-contributors.png), 콘솔 오류0 |
| 배포 요청 본문 | Vercel helper 선소비 방지·64KB 유지 | helpers:false 적용, 실제 설치된 runtime 재현 통과, [vercel-request-body.json](../verification/vercel-request-body.json) |

합성 fixture는 기능 시험 근거이며 본인 실제 활동으로 사용하지 않는다. cloud 이전 근거는 **회고 추가 전** Plan1/history2/Task7/Execution3/completion4/receipt4/review0 시점이다. 이후 실제 회고로 바뀐 현재 전체 state의 해시라고 쓰지 않는다.

이전 당시 local/PG state SHA-256은 모두 bfc7a05a652dbc79265f7f14fa7132050db3abf15cf90f33f6b244373ba0a460, export 데이터 해시는 모두 bab0e320d077304f95d3217e678de6e01ff242e9581922e53fb2ac015e6480b9이다. [이전 도구](../scripts/transfer-to-cloud.mjs)의 재준비는 already_matches로 건너뛰었고 덮어쓰기·삭제하지 않았다. 회고 추가 뒤 local/cloud가 달라지면 이 동일성 검사가 실패할 수 있으며 자동 재복사를 하지 않는다.

## 날짜·계산·DB·안전성

계획 수는 선택 Plan의 삭제되지 않은 Task 수, 완료는 현재 완료 상태, 지연은 미완료이고 마감일이 서울 오늘보다 이전인 Task 수다. 막힘은 비어 있지 않은 이유가 하나 이상 있는 Task 수다. 예상은 대상 Task의 예상 분 합계, 실제는 연결된 모든 실행 분 합계, 차이는 실제−예상이며 빈 합계는0이다. 선택 계획 기간을 표시하고 마감일로 전체 Task를 임의로 축소하지 않는다.

DB는 plans·plan_history·tasks·executions·completion_events·request_receipts·reviews의7표이다. [pds-schema-v2.json](../contracts/pds-schema-v2.json)은 실제 운영 PostgreSQL 카탈로그 7표·58필드와 로컬 SQLite PRAGMA를 함께 보존하며 모든 필드명이 일치한다. 운영 조회 시각은 2026-09-30 10:25:54 서울이다. [postgres-catalog.json](../verification/postgres-catalog.json)에 인덱스16·RLS정책17·INVOKER함수9·이력불변트리거1을 저장했다. 생성기 재실행은 이 저장된 조회 시각을 유지하며 운영 DB를 새로 검사했다고 표시하지 않는다. PG 구조/RPC는 [postgres.sql](../db/postgres.sql)과 [optimize-postgres.sql](../db/optimize-postgres.sql)에 있다.

완료는 요청 ID/Task주기 고유 제약·영수증으로 중복을 막고 PG는 요청 advisory lock 뒤 Task 행을 잠근다. 다시 열기 뒤 과거 요청이 재도착해도 완료 상태를 다시 적용하지 않는다. Plan 이력 UPDATE/DELETE는 거절한다. Task 삭제는 연결 근거를 보존한다.

PG에는 RLS·SECURITY INVOKER·컬럼별 권한을 적용하며 RPC transaction-local gate 밖의 원시 테이블 쓰기를 거절한다. 클라이언트에 DB 키를 넣지 않고 서버 publishable 키만 사용한다. service-role/secret 키는 사용하지 않는다. .env·실제/시험 DB·Vercel 연결 상태는 Git에서 제외한다. 소스 검사·CSP·입력 제한은 확인 범위의 근거이며 공개 배포·네트워크·콘솔·최종 Git 비밀값은 별도 점검한다.

## 배포·제출·T07 상태

공개 저장소 [PeterAhnn/SKT-ALEPH-Project-6-Diary](https://github.com/PeterAhnn/SKT-ALEPH-Project-6-Diary)를 만들었다. 최종 push·실제 전체 커밋·고정 소스 URL은 확인 전이다. Vercel CLI61.1.0, 계정 ahs3810, scope peter-ahns-projects, 프로젝트 skt-aleph-project-6-diary의 첫 운영 배포는 READY이다. [공개 결과물](https://skt-aleph-project-6-diary.vercel.app) health 요청에서 HTTP200·postgres·authentication:false를 확인했다.

확인: 격리된 gstack 브라우저의 공개 화면·실제 집계·기여 기록·375px 화면·가로 넘침 없음·콘솔 오류0, 무인증 API state 재조회/전체 export와 정적 파일 SHA 일치. 최신 전체 자료는 [current-export.json](../verification/current-export.json) 한 파일에 보관했다. 내장 브라우저에도 공개 앱을 열어 두었다.

남은 최종 확인: 최종 push/전체 커밋·고정 소스 공개 접근, 수정된 배포 요청 본문과 서버 첨부 다운로드의 공개 실행, 배포/커밋 일치 및 최종 T07 기준점. 플랫폼 제출·접수·강사/마스터 승인은 수행하지 않았다.

제출 항목은 검증한 공개 HTTPS 결과물·실제 소문자 전체 커밋 /commit/ URL·확인4항목·실제 AI/사용자 판단3항목이다. [SUBMISSION.md](SUBMISSION.md)에 문안을 관리한다. 보고서·증거 화면은 임의로 필수 첨부로 추가하지 않는다.

사용자의 실제 결정은 기록 주제, 추천300분 계획·Task7·실측 AI 협업3건 사용, Supabase 조직/월$0 생성, 내장 브라우저 기본, 개선 한 줄이다. T07 전에 실제 스키마·승인 원자료·전체 JSON export·근거·공개 URL·검증한 전체 커밋을 보존해 제출 당시 상태를 다시 확인할 수 있게 한다.
