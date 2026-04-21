---
title: '수십억 row 테이블 최적화하기 (3)'
description: ''
pubDate: '2025-11-21'
category: '데이터베이스'
tags: []
draft: false
---

[1편](/posts/actionlog-optimization-1)에서 인덱스를 추가해 1시간 → 51초로 줄였고, [2편](/posts/actionlog-optimization-2)에서는 파티셔닝 전에 쿼리를 정비했다.

23개 쿼리 전부 인덱스를 활용하고, 파티션 프루닝이 동작하는 상태다. 이제 파티셔닝을 적용한다.

---

## 파티션 설계

### 어떤 기준으로 나눌까?

파티셔닝에서 가장 중요한 결정은 **파티션 키**를 뭘로 잡느냐다. 우리의 경우 선택지는 명확했다.

| 후보 | 장점 | 단점 |
|------|------|------|
| `userId` | 유저별 조회 빠름 | 기간 조회에 도움 안 됨 |
| `type` | 타입별 분리 | 종류가 10~15개뿐 |
| **`createDate`** | **기간 조회 최적화, 데이터 관리 용이** | **PK 변경 필요** |

대부분의 분석 쿼리가 "최근 N개월" 패턴이고, 오래된 데이터는 아카이빙하거나 삭제할 수도 있으니 `createDate`가 자연스러웠다.

### 최종 설계

| 항목 | 결정 |
|------|------|
| 파티션 키 | `createDate` |
| 파티션 단위 | **월별 (Monthly)** |
| 보관 기간 | 과거 24개월 + 미래 3개월 |
| 총 파티션 수 | 27개 |
| 파티션 방식 | `RANGE (TO_DAYS(createDate))` |

```sql
CREATE TABLE ActionLog_partitioned (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  userId INT UNSIGNED NULL,
  productId INT UNSIGNED NULL,
  storeId INT UNSIGNED NULL,
  type TINYINT NOT NULL,
  createDate TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id, createDate),
  INDEX idx_type_createDate (type, createDate),
  INDEX idx_createDate (createDate),
  INDEX idx_userId (userId),
  INDEX idx_productId (productId),
  INDEX idx_storeId (storeId)

) PARTITION BY RANGE (TO_DAYS(createDate)) (
  PARTITION p202401 VALUES LESS THAN (TO_DAYS('2024-02-01')),
  PARTITION p202402 VALUES LESS THAN (TO_DAYS('2024-03-01')),
  PARTITION p202403 VALUES LESS THAN (TO_DAYS('2024-04-01')),
  -- ... 월별로 쭉 ...
  PARTITION p202603 VALUES LESS THAN (TO_DAYS('2026-04-01')),
  PARTITION p_future VALUES LESS THAN MAXVALUE
);
```

여기서 한 가지 짚고 넘어갈 게 있다.

---

## PK를 왜 바꿔야 하나요?

원래 ActionLog의 PK는 `id` 하나였다. 그런데 파티션 테이블에서는 `PRIMARY KEY (id, createDate)`로 바뀌었다.

이건 MySQL 파티셔닝의 **제약 조건** 때문이다.

> **파티션 키는 반드시 모든 유니크 인덱스(PK 포함)에 포함되어야 한다.**

이유는 단순하다. MySQL이 INSERT할 때 "이 row를 어느 파티션에 넣을지"를 판단해야 하는데, PK만 보고도 그 판단을 할 수 있어야 한다. PK에 파티션 키가 없으면 MySQL은 모든 파티션을 뒤져서 유니크 여부를 확인해야 하니까.

```
PK가 (id)일 때:
INSERT INTO ActionLog (id=100, createDate='2025-03-15')
→ "id=100이 이미 존재하는지 확인해야 해..."
→ 27개 파티션 전부 확인 😱

PK가 (id, createDate)일 때:
INSERT INTO ActionLog (id=100, createDate='2025-03-15')
→ "createDate가 2025-03이니까 p202503 파티션이군"
→ 해당 파티션에서만 id=100 확인 ✅
```

id의 유니크성이 깨지는 건 아닌가? 이론적으로는 다른 파티션에 같은 id가 들어갈 수 있다. 하지만 `AUTO_INCREMENT`가 테이블 레벨에서 동작하기 때문에 같은 id가 생길 일은 없다.

---

## 버퍼 풀: 파티셔닝이 빠른 진짜 이유

여기서 잠깐. 1편에서 인덱스를 추가했을 때 1시간 → 51초로 줄었다. 인덱스가 범위를 좁혀주니까. 그런데 파티셔닝을 추가하면 왜 더 빨라지는 걸까? 인덱스가 이미 범위를 잡고 있는데?

답은 **버퍼 풀(Buffer Pool)**에 있다.

### 버퍼 풀이 뭔가요?

MySQL(InnoDB)은 디스크에서 읽은 데이터를 **메모리에 캐싱**해둔다. 이 캐시 영역을 버퍼 풀이라고 한다.

```
[디스크]  →  느림 (1~10ms)
[메모리]  →  빠름 (나노초)
```

같은 데이터를 다시 읽을 때 디스크까지 안 가고 메모리에서 바로 꺼내올 수 있으니 빠르다. 문제는 메모리가 유한하다는 것이다.

### 수십억 건의 B-Tree는 메모리에 안 올라간다

1편에서 만든 `idx_type_createDate` 인덱스를 생각해보자. 수십억 건의 데이터를 커버하는 B-Tree다. 이 인덱스의 크기만 해도 **수십 GB**에 달한다.

서버의 버퍼 풀이 아무리 크다고 해도 (보통 물리 메모리의 70~80%), 이 거대한 인덱스를 전부 올려놓기는 힘들다. 결국 인덱스를 타면서도 디스크 I/O가 발생한다. 51초의 정체는 이것이었다.

### 파티셔닝이 버퍼 풀 문제를 해결한다

파티셔닝을 하면 이 거대한 B-Tree가 **27개의 작은 B-Tree로 쪼개진다.**

```
파티셔닝 전:
┌─────────────────────────────────┐
│   하나의 거대한 B-Tree (수십 GB)  │ → 버퍼 풀에 안 올라감
│   인덱스 탐색 시 디스크 I/O 발생   │ → 51초
└─────────────────────────────────┘

파티셔닝 후:
┌────┐┌────┐┌────┐┌────┐┌────┐┌────┐  ...
│p01 ││p02 ││p03 ││p04 ││p05 ││p06 │  ← 각각 작은 B-Tree
│skip││skip││skip││skip││skip││skip│
└────┘└────┘└────┘└────┘└────┘└────┘
                          ┌────┐┌────┐┌────┐┌────┐┌────┐┌────┐
                          │p22 ││p23 ││p24 ││p25 ││p26 ││p27 │
                          │skip││skip││scan││scan││scan││scan│
                          └────┘└────┘└────┘└────┘└────┘└────┘
                                       ↑ 최근 6개월 파티션만 접근
                                       ↑ 작은 인덱스 → 버퍼 풀에 올라감
                                       ↑ 디스크 I/O 격감 → 초 단위
```

6개월 조회면 6개 파티션만 본다. 각 파티션의 인덱스는 전체의 1/27 크기라 **버퍼 풀에 올라갈 수 있다.** 메모리에서 바로 읽으니 디스크 I/O가 거의 사라진다.

이게 파티셔닝의 진짜 가치다. 단순히 "데이터를 나눠서 적게 읽는다"가 아니라, **"인덱스가 메모리에 올라갈 수 있는 크기로 줄어든다"**는 것이다.

Percona(MySQL 성능 전문 기업)의 분석도 동일한 결론이다:

> "Partitioning helps when **active working set fits in buffer pool per partition**."
> (파티셔닝은 각 파티션의 활성 데이터가 버퍼 풀에 올라갈 수 있을 때 효과적이다.)

---

## 마이그레이션: 수십억 건을 어떻게 옮기나

파티션 설계는 끝났다. 하지만 수십억 건짜리 프로덕션 테이블을 "바꿔치기"하는 건 쉬운 일이 아니다. 한 번에 교체하면 서비스가 멈출 수 있다.

그래서 **7단계 무중단 전환 전략**을 세웠다.

```
Step 1  신규 파티션 테이블 생성
   ↓
Step 2  청크 단위로 데이터 복사 (10만 row/batch)
   ↓
Step 3  dual-write 시작 (기존 + 신규 동시 쓰기)
   ↓
Step 4  데이터 정합성 검증
   ↓
Step 5  read를 신규 테이블로 전환
   ↓
Step 6  dual-write 중단, 신규 테이블만 사용
   ↓
Step 7  기존 테이블 2주 보관 후 삭제
```

### 왜 dual-write인가?

핵심은 **Step 3~5의 dual-write 구간**이다.

데이터 복사(Step 2)에는 시간이 걸린다. 수십억 건을 10만 건씩 옮기면 수시간~수일이 소요된다. 그 사이에도 서비스는 계속 돌고 있고, 새로운 데이터가 계속 쌓인다.

dual-write를 하면 복사 기간 동안 **새로 들어오는 데이터가 양쪽 테이블에 모두 쌓인다.** 복사가 끝나면 두 테이블의 데이터가 동일해진다.

```
시간 ──────────────────────────────────────────────────▶

         복사 시작        복사 완료       read 전환     write 전환
            │               │              │              │
기존 테이블:  ████████████████████████████████████████████░░░░░
신규 테이블:  ░░░░████████████████████████████████████████████
                 ↑                         ↑
              dual-write                read 전환
              구간 시작                  (신규로)

█ = 활성 사용 중    ░ = 보관 중
```

이 전략의 장점은 **언제든 롤백이 가능하다**는 것이다. 신규 테이블에 문제가 생기면 read를 다시 기존 테이블로 돌리면 된다. 안전벨트 없이 운전하는 건 취향이 아니다.

---

## 비슷한 규모의 실제 사례들

비슷한 규모에서 파티셔닝을 적용한 실제 사례들이다.

| 사례 | 규모 | Before | After | 개선 |
|------|------|--------|-------|------|
| **Cisco AMP** | 10억 rows, 492GB | 로드밸런서 타임아웃 | 정상 응답 | audit log 파티셔닝 |
| **Tookan** | 5억+ rows | 수 초~수십 초 | ms 단위 | **2000x** |
| **Invoca** | 수백만/일 적재 | DELETE 6시간 | DROP 1.5초 | 운영 비용 극감 |
| **Medium 사례** | 수십억 rows | 500초 | 2초 | **250x** |

공통점이 보인다. **수억~수십억 건 규모에서 파티셔닝은 수십~수백 배의 개선**을 보여준다. 특히 시계열 데이터(로그, 이벤트, 감사 기록)에서 효과가 극적이다.

---

## 최종 결과

전체 최적화 과정의 결과를 정리하면 이렇다.

<div style="overflow-x: auto; margin: 2rem 0;">
<table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
<thead>
<tr style="background: #f8f9fa;">
<th style="padding: 0.75rem; text-align: left; border-bottom: 2px solid #dee2e6;">단계</th>
<th style="padding: 0.75rem; text-align: center; border-bottom: 2px solid #dee2e6;">실행 시간</th>
<th style="padding: 0.75rem; text-align: center; border-bottom: 2px solid #dee2e6;">개선율</th>
<th style="padding: 0.75rem; text-align: left; border-bottom: 2px solid #dee2e6;">한 일</th>
</tr>
</thead>
<tbody>
<tr>
<td style="padding: 0.75rem;">Before</td>
<td style="padding: 0.75rem; text-align: center; font-weight: bold;">1시간+</td>
<td style="padding: 0.75rem; text-align: center;">—</td>
<td style="padding: 0.75rem;">Full Table Scan</td>
</tr>
<tr>
<td style="padding: 0.75rem;">Phase 1</td>
<td style="padding: 0.75rem; text-align: center; font-weight: bold;">51초</td>
<td style="padding: 0.75rem; text-align: center;">~70x</td>
<td style="padding: 0.75rem;">B-Tree 인덱스 추가</td>
</tr>
<tr>
<td style="padding: 0.75rem;">Phase 1.5</td>
<td style="padding: 0.75rem; text-align: center; font-weight: bold;">51초 (안정화)</td>
<td style="padding: 0.75rem; text-align: center;">—</td>
<td style="padding: 0.75rem;">쿼리 정비, Phase 2 기반 마련</td>
</tr>
<tr>
<td style="padding: 0.75rem;">Phase 2</td>
<td style="padding: 0.75rem; text-align: center; font-weight: bold;">5~15초</td>
<td style="padding: 0.75rem; text-align: center;">~수백x</td>
<td style="padding: 0.75rem;">월별 파티셔닝 + 무중단 전환</td>
</tr>
</tbody>
</table>
</div>

**1시간 넘게 걸리던 쿼리가 초 단위로 줄었다.**

---

## 돌이켜보며

이번 최적화를 통해 몇 가지를 배웠다.

### 1. 단계적으로 접근하자

처음부터 파티셔닝으로 달려갔다면 어떻게 됐을까? 61%의 쿼리가 파티션 프루닝을 못 타면서 오히려 성능이 나빠졌을 것이다. "인덱스 → 쿼리 정비 → 파티셔닝" 순서를 지켰기에 각 단계에서 안전하게 검증할 수 있었다.

### 2. 측정 없이 최적화하지 말자

"감으로" 최적화하면 십중팔구 삽질한다. Before 수치를 먼저 찍어두고, 각 단계마다 After를 측정했기에 "이 단계에서 멈춰도 되는지, 더 가야 하는지"를 판단할 수 있었다.

### 3. 인덱스가 있다고 끝이 아니다

인덱스를 아무리 잘 만들어도, 쿼리가 인덱스를 활용할 수 없는 형태면 소용없다. `DATE()` 함수 하나가 인덱스를 무용지물로 만들 수 있다. 인덱스를 만드는 것만큼, 쿼리가 그 인덱스를 제대로 타는지 확인하는 것이 중요하다.

### 4. 파티셔닝은 만능이 아니다

파티셔닝은 **파티션 키가 WHERE 절에 있을 때만** 효과가 있다. 그렇지 않으면 오히려 오버헤드만 늘어난다. "파티셔닝 = 빨라진다"가 아니라, "파티셔닝 + 올바른 쿼리 = 빨라진다"가 맞다.

---

## 정리

수십억 건짜리 테이블도 제대로 접근하면 길이 보인다. 이 시리즈에서 다룬 전체 흐름을 한 줄로 요약하면:

> **인덱스로 탐색 범위를 줄이고, 쿼리를 고쳐서 인덱스를 타게 만들고, 파티셔닝으로 인덱스 자체를 메모리에 올린다.**

각 단계가 다음 단계의 기반이 되는 구조다. 어느 하나를 건너뛰면 다음 단계가 제대로 작동하지 않는다. 최적화에 왕도는 없지만, 순서를 지키면 안전하게 도달할 수 있다.

이 글이 비슷한 상황에 처한 누군가에게 도움이 되었으면 한다.

> 시리즈
> - [수십억 row 테이블 최적화하기 (1)](/posts/actionlog-optimization-1)
> - [수십억 row 테이블 최적화하기 (2)](/posts/actionlog-optimization-2)
> - **수십억 row 테이블 최적화하기 (3)** ← 현재 글
