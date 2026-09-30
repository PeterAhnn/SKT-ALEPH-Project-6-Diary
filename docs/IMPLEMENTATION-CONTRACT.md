# T06 구현 계약 — 팀 작업용

2026-09-30. 아래는 확인된 과제 기준을 구현하는 선택이며 공식 지정 기술이 아니다.

## 실행과 저장

- Node.js 24의 기본 HTTP 서버, ES modules, 외부 프레임워크 없이 한국어 앱.
- 로컬: Node `node:sqlite`의 실제 디스크 SQLite DB. 기본 `.data/diary.sqlite`. 시험 DB는 `.test-data/` 별도 파일이며 본인 실제 자료를 자동 생성하지 않는다.
- 공개 배포: Vercel Node API + 실제 Supabase PostgreSQL에 저장한다. 사용자에게 PeterAhn's Org·조회 월 0 비용을 확인받아 서울 지역 DB를 생성했다. API는 generic Vercel runtime의 helpers:false로 원시 JSON 본문과 공통 64KB 제한을 유지한다. 실제 운영 DB 7표·58필드는 contracts/pds-schema-v2.json에 로컬 SQLite와 함께 보존한다.
- 시간 단위는 분(minutes)으로 통일하는 구현 선택. DB 시각은 UTC ISO 문자열, 날짜는 YYYY-MM-DD, 지연 판정은 Asia/Seoul 오늘보다 앞선 미완료 마감일.
- 실사용 앱은 빈 DB로 시작한다. 시험 서버 `DIARY_RECORD_ORIGIN=synthetic`에서만 합성 기록을 생성한다. 실제 본인 기록과 섞지 않는다.

## DB 모델

공통 ID는 UUID 문자열, created_at/updated_at은 UTC ISO 문자열. priority는 high/medium/low. 시간 값은 0 이상의 정수 분. 날짜·수량 상한과 문자열 길이 등은 서버에서 검증한다.

- plans: id,title,description,start_date,end_date,priority,success_criteria,expected_minutes,version,source_review_id(nullable UNIQUE),carried_improvement,record_origin(user/synthetic),created_at,updated_at.
- plan_history: id,plan_id,version,snapshot_json,created_at. 초기 버전부터 변경 후 버전까지 불변 스냅샷. UNIQUE(plan_id,version). snapshot_json은 저장소 내부에서는 JSON 문자열이며 API state에서는 snapshot 객체로 반환.
- tasks: id,plan_id,title,notes,due_date(nullable),priority,tags_json,expected_minutes,status(pending/completed),completion_cycle(default0),version,deleted_at(nullable),record_origin,created_at,updated_at. tags_json은 내부 JSON 문자열, API에서는 tags 배열.
- executions: id,task_id,started_at,ended_at,actual_minutes,blocked_reason,record_origin,created_at. 실행 추가는 Plan·Task 예상 시간과 상태를 변경하지 않는다.
- completion_events: id,task_id,cycle,request_id,completed_at. UNIQUE(task_id,cycle), UNIQUE(request_id). 현재 완료 수는 tasks.status로 계산하며 과거 완료 기록 수를 세지 않는다.
- request_receipts: request_id(PK),action,resource_id,response_json,created_at. 완료/다시열기의 동일 요청 재전송을 처리한다. 응답 JSON은 API state에서 response 객체로 반환.
- reviews: id,plan_id,improvement,next_plan_id(nullable),record_origin,created_at. 개선을 다음 Plan에 연결할 때 원문 improvement와 source_review_id를 보존한다.

## 저장소 인터페이스

`src/store-sqlite.mjs`는 `export function createSqliteStore({filename, clock, recordOrigin='user'})`를 제공한다. `clock` 기본은 `() => new Date().toISOString()`.

반환 객체: `kind='sqlite'`, `async state()` 전체 자료 객체, `async mutate(action,payload)` 트랜잭션 결과, `async close()`.

`src/store-supabase.mjs`도 kind='postgres'와 동일 인터페이스를 제공한다. Supabase RPC `pds_state()`는 아래 state를 하나의 DB 스냅샷으로 반환한다. `pds_mutate(p_action text,p_payload jsonb)`는 아래 action을 하나의 트랜잭션으로 처리한다. RLS와 SECURITY INVOKER를 사용하며 T06 전용 공개 자료만 저장한다. publishable/anon 키는 서버 환경에서 사용하고 비밀키를 사용하거나 브라우저에 넣지 않는다. 프로젝트의 다른 데이터·설정은 변경하지 않는다.

state 객체: `{plans,plan_history,tasks,executions,completion_events,request_receipts,reviews}`. 모든 날짜/숫자는 저장한 값 그대로, tags와snapshot과response만 위에서 정의한 JSON 객체/배열로 변환한다.

mutate 결과: `{entity:<생성/변경 객체>, changed:boolean, replayed?:boolean, event?:<완료기록>, review?:<회고객체>}`. 생성 성공은 entity를 반환한다.

action 목록과 payload:

- plan.create: 계획 필드(title,description,start_date,end_date,priority,success_criteria,expected_minutes). DB에서 id/version=1/origin/timestamps를 생성하고 history v1을 저장한다.
- plan.update: `{id,expected_version,...계획 필드}`. 버전 불일치는409. 같은 ID로version+1 및 history 저장. source_review_id/carried_improvement는 변경하지 않는다.
- task.create: `{plan_id,title,notes,due_date,priority,tags,expected_minutes}`.
- task.update: `{id,expected_version,title,notes,due_date,priority,tags,expected_minutes}`. 버전불일치409. 삭제된 task에는404.
- task.complete: `{id,request_id}`. 같은 request ID는 receipt로 재생한다. 같은 task/cycle에 완료기록은1개. 이미완료면 추가기록없음. pending→completed에서만 version+1.
- task.reopen: `{id,request_id}`. receipt로 동일 요청 재생. completed→pending에서만 completion_cycle+1/version+1. 이미pending이면 변화없음. 완료 이력은 보존.
- task.delete: `{id}`. soft delete로deleted_at만설정하고version+1. 기존 실행/완료이력보존.
- task.restore: `{id}`. 삭제를되돌리고version+1.
- execution.create: `{task_id,started_at,ended_at,actual_minutes,blocked_reason}`. task삭제면404. 시각은UTC ISO로정규화된값.
- review.create: `{plan_id,improvement}`. 비어있지않은 개선한줄저장.
- review.next-plan: `{id:<review_id>,...계획필드}`. 같은 review에서다음Plan은1개. 이미연결됐으면 기존Plan을 반환하며추가생성하지않는다. 신규Plan source_review_id/carried_improvement 저장+history v1+reviews.next_plan_id를원자적으로연결.

Error는 `status`(400/404/409)와안전한`message`를가진Error객체. SQL 제약/내부 파일경로/키값은HTTP응답에드러내지않는다.

## HTTP API

- GET `/api/state`: `{ok:true,data:<state>,meta:{storage,timezone:'Asia/Seoul',time_unit:'minutes',today:'YYYY-MM-DD',authentication:false,record_origin:'user'|'synthetic'}}`.
- GET `/api/export`: 전체state+`schema_version:2,exported_at,timezone,time_unit,record_origin`를JSON파일1개로download.
- GET `/api/health`: `{ok:true,storage,authentication:false}`.
- POST `/api/plans`, PATCH `/api/plans/:id`.
- POST `/api/plans/:id/tasks`, PATCH `/api/tasks/:id`, DELETE `/api/tasks/:id`.
- POST `/api/tasks/:id/complete`, `/reopen`, `/restore`, `/executions`.
- POST `/api/plans/:id/reviews`, POST `/api/reviews/:id/next-plan`.
- mutation응답은`{ok:true,data:<mutate result>}`. 실패는`{ok:false,error:{code,message}}`. 실패 시 입력을 유지하고 재시도 방법을 화면에 표시한다.

## 브라우저 공통 모듈

루트 담당 `public/core.mjs`: `aggregate(state,planId,today)`와`selectTasks(tasks,{planId,search='',status='all',priority='all',tag='',sort='due'})`, `seoulToday(date=new Date())`.

aggregate 결과: `{planned,completed,overdue,blocked,expected_minutes,actual_minutes,delta_minutes,evidence:{planned:<task IDs>,completed:<task IDs>,overdue:<task IDs>,blocked:<task IDs>,expected_minutes:<task IDs>,actual_minutes:<execution IDs>,delta_minutes:<task IDs>}}`.

계획 선택으로 기간별 회고를 제공한다. 집계 대상은 선택Plan에딸린삭제되지않은모든Task. 마감일 필터로C28의 전체할일수를임의로축소하지않는다. 실제시간은대상Task의모든Execution합계.

selectTasks 검색은title/notes/tags 대상 한국어 검색, 상태/우선순위/태그 필터, sort=due/priority/created. due: 마감일오름차순(미정맨뒤)→우선순위 high먼저→created_at→id. priority: high먼저→due→created_at→id. created: created_at내림차순→id. 이규칙을화면에표시.

## UI

정확한공개안내를첫화면에표시. 한국어 Plan/Do/See 작업 화면, 빈상태에서 본인계획을직접입력. Plan입력과불변이력보기, Task CRUD·완료/되돌림·검색/필터/정렬, Execution입력/연결보기, See 지표클릭근거보기, Review개선입력/다음Plan생성, 전체JSON내보내기.

데이터는textContent/DOM으로표시하며innerHTML에사용자문자열을넣지않는다. 서버오류/빈상태/저장중/충돌을알리고실패시입력값을유지. 삭제는softdelete이므로되돌림을제공. 모바일에서도사용가능. DB키·API내부정보는제품화면에노출하지않는다.
