# T06 제출 직전 요구사항 대조

확인일: 2026-09-30. [공식 과제 화면](https://aleph-omega.vercel.app/cortex?panel=tasks)의 전체 설명·목적·제출물·완주 체크리스트·카드 1~5의 하는 일/첫 행동/통과 기준/막히는 지점과 확인 순서/남길 것·실제 제출 폼을 기존 인증된 Codex 내장 브라우저에서 다시 읽었다. 화면에 표시된 기준 번호만 사용하며 C01~C83의 누락 번호를 추정하지 않는다.

## 만들고 검증한 결과

| 단계 | 공식 기준 | 실제 기능·검증 결과 | 남긴 근거 |
|---|---|---|---|
| 1. 계획 세우기 | C04~C08 | 기간·우선순위·성공 기준·예상 분 저장, 같은 ID의 v1/v2 보존. 실제 공개 UI에서 두 이력을 펼쳐 확인 | [공개 Plan/이력 화면](../verification/plan-history-public.png), 전체 export·로컬/PG 검사 |
| 2. 할 일 다루기 | C09~C20 | 생성·수정·완료·다시 열기·삭제·복구, 마감/우선순위/태그/예상 분, 검색·조건 필터·표시된 정렬/동률 규칙 | 자동 검사·[실제 합성 UI 행동/전후값·화면4장 대응](../verification/synthetic-screen-evidence.json)·[수정/다시 열기](../verification/synthetic-task-edit-reopen.png)·[삭제](../verification/synthetic-task-delete.png)·[검색/필터/정렬](../verification/synthetic-search-filter-sort.png) |
| 3. 실제로 한 일 적기 | C21~C27 | 시작/끝/실제 분/막힌 이유를 할 일에 연결, Plan 값 유지. 같은 요청과 다른 요청 키의 반복 완료는 기록1건·집계+1. 다시 열기 뒤 과거 요청 재생도 미변경 | [실제 PG35 결과](../db/verify-postgres-optimized-result.json), API 검사·[실행 기여 화면](../verification/actual-contributors.png) |
| 4. 돌아보기와 다음 계획 | C28~C33, C83 | 삭제 제외7·현재 완료4·서울 지연0·막힌 할 일3, 예상300/실제18/차이−282분. 지표의 근거 이동, 사용자 개선 원문의 회고/다음 Plan 연결 | [See](../verification/see-desktop.png), [기여 기록](../verification/actual-contributors.png), 전체 export·양방향 ID 대조 |
| 5. 내 자료와 보존 | C34~C36, C78~C82 | 승인 계획1+할 일7+실측 AI 협업 실행3, 실제 PostgreSQL7표·58필드, 0 아닌 See, 새로고침 뒤 ID/날짜/값/단위 유지, 전체 한 파일 실제 다운로드, 정확한 첫 화면 공개 안내 | [승인 정본](../records/user-approved-recommendation.json), [계약](../contracts/pds-schema-v2.json), [다운로드 자료](../verification/browser-export.json), 공개/모바일 화면 |
| 5. 최종 안전성·제출 | C01, C57~C60 | 합성 스크립트 문자열 문자 표시·미실행, 비밀키 점검, 앱/고정 소스 무인증 접근, 확인4항목·판단3항목, 배포와 고정 소스 코드 일치 | XSS/소스·콘솔/네트워크·Git 점검, [배포/소스 대조](../verification/delivery.json), [제출 직전 공개 대조](../verification/pre-submission-public.json), [제출 문안](SUBMISSION.md) |

완주 체크리스트의 Plan→Do→See 실제 DB 연결, 실제 승인 자료, 집계 근거 이동, 첫 화면 공개 안내, 최종 소스/문자열/비밀값/공개 접근 검사를 각각 대응시켰다. Node27/27·실제 PG35/35는 이미 수행한 검사 결과이며 이번 제출 직전 반복 수행했다고 쓰지 않는다.

## 실제 기록과 합성 검사 구분

사용자가 이전 과제에서 추천해 달라고 요청하고 추천안을 그대로 채택했다. 실제 계획은 채택한 현재 계획이며 예상300분은 추천값이다. 실행3건은 T05 도구의 실제 AI 협업 구간을 출처 초·시각·해시와 함께 가져왔으며 학생 직접 공부 시간을 측정했다고 쓰지 않는다. 합성 UI 자료는 기능 검사용으로만 사용한다.

최신 C78~C81의 원문은 실제 계획1·그 계획의 할 일5·실제로 한 일3·그 자료의 0 아닌 See를 요구한다. 직접 공부 시간만 허용하거나 AI 협업 실행을 배제하는 추가 조건은 표시되지 않았다. 사용자 개선 **작업 전에 파일 읽기와 검사 실행 권한부터 확인한다**는 **ALEPH 남은 검증 마무리**(10/1~10/2)에 연결되어 있다.

## 제출 직전 현재 공개 결과

2026-09-30T09:02:42.909Z 무인증 GET으로 앱·health·state·export·고정 GitHub 커밋 모두 HTTP200·리다이렉트 없음을 확인했다. 저장된 전체 export와 현재 DB7표의 ID·날짜·값·단위가 같고 차이 배열은 비어 있다. 기존 export/T07 기준 파일을 덮어쓰거나 실제 기록을 바꾸지 않았다.

제출 값은 결과물 HTTPS 주소, 고정 소스 [b9de0298cd200961eac56286c6a6a55299947a96](https://github.com/PeterAhnn/SKT-ALEPH-Project-6-Diary/commit/b9de0298cd200961eac56286c6a6a55299947a96), 확인 문안465자, 판단 문안318자이다. 두 문안은 각각1,500자 이내이며 공식 제출 폼에 입력해 값을 대조했다. 확인 파일은 선택이고 별도 보고서 첨부는 공식 필수가 아니다.

## 완료와 남은 상태

기능·실제 자료·DB·공개 배포·고정 소스·검증·단계별 화면 보존을 마쳤다. 착수 상태로 남아 있던 TASK-READBACK 문서를 현재 결과와 맞췄다. 2026-09-30 18:10 한국 시간에 공식 폼으로 제출해 “T06 제출을 마쳤습니다”를 확인했고 현재는 **강사 승인 대기**다. [접수 기록](../verification/platform-submission.json)·[완료 화면](../verification/submission-success.png)·[대기 화면](../verification/submission-pending.png)을 보존했다. 강사/마스터 승인과 별도 채점은 완료 처리하지 않는다.
