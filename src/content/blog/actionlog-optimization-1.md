---
title: '수십억 row 테이블 최적화하기 (1)'
description: ''
pubDate: '2025-11-21'
category: '데이터베이스'
tags: []
draft: false
---

서비스를 운영하다 보면 "이 쿼리 왜 이렇게 느리지?"라는 순간이 반드시 온다. 우리 팀도 그랬다.

어느 날 마케팅 팀에서 요청이 하나 들어왔다.

> 최근 6개월간 좋아요 5회 이상이거나 장바구니 3회 이상 담은 유저 리스트 좀 뽑아주세요.

평범한 요청이었다. 쿼리를 돌렸다. 그리고 기다렸다. 커피를 한 잔 내려 마셨다. 돌아와도 여전히 돌고 있었다. 커피를 한 잔 더 내려 마시고 돌아왔는데도 돌고 있었다.

**1시간.**

이건 "좀 느리네" 수준이 아니었다. 뭔가 근본적인 문제가 있다는 신호였다.

이 글은 수십억 건이 쌓인 ActionLog 테이블을 **인덱스 최적화 → 쿼리 수정 → 파티셔닝**이라는 3단계에 걸쳐 개선한 시리즈의 첫 번째 편이다. 삽질도 있었고, 예상 못한 발견도 있었다.

---

## 전체 최적화 로드맵

본격적인 이야기 전에, 전체 그림을 먼저 그려보자. 이 시리즈가 다루는 전체 과정은 다음과 같다.

<div style="display: flex; gap: 0.5rem; align-items: center; overflow-x: auto; margin: 2rem 0;">
<div style="flex: 1; min-width: 160px; padding: 1rem; background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px; text-align: center;">
<strong>Phase 0</strong><br/>현황 분석<br/><br/><span style="font-size: 0.85rem; color: #666;">측정 기준 쿼리 선정<br/>인덱스 전수 조사</span>
</div>
<div style="font-size: 1.2rem; color: #adb5bd;">→</div>
<div style="flex: 1; min-width: 160px; padding: 1rem; background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px; text-align: center;">
<strong>Phase 1</strong><br/>인덱스 최적화<br/><br/><span style="font-size: 0.85rem; color: #666;">B-Tree 인덱스 추가<br/>복합 인덱스 설계</span>
</div>
<div style="font-size: 1.2rem; color: #adb5bd;">→</div>
<div style="flex: 1; min-width: 160px; padding: 1rem; background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px; text-align: center;">
<strong>Phase 1.5</strong><br/>쿼리 정비<br/><br/><span style="font-size: 0.85rem; color: #666;">23개 쿼리 전수조사<br/>DATE() 함수 제거</span>
</div>
<div style="font-size: 1.2rem; color: #adb5bd;">→</div>
<div style="flex: 1; min-width: 160px; padding: 1rem; background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px; text-align: center;">
<strong>Phase 2</strong><br/>파티셔닝<br/><br/><span style="font-size: 0.85rem; color: #666;">월별 파티션<br/>dual-write 전환</span>
</div>
</div>

왜 이 순서인가? **가장 비용이 낮고 효과가 큰 것부터** 적용하기 위해서다. 인덱스 추가는 서비스 중단 없이 할 수 있지만, 파티셔닝은 테이블 구조 자체를 바꿔야 한다. 쉬운 것부터 하고, 각 단계마다 측정해서 "여기서 멈춰도 되는지"를 판단하는 방식이다.

이번 편에서는 **Phase 0 ~ Phase 1**, 즉 문제 발견부터 인덱스 최적화까지를 다룬다.

---

## ActionLog가 뭔데?

ActionLog는 말 그대로 **유저의 행동을 기록하는 테이블**이다. 유저가 상품을 클릭하면 `type = 5`, 좋아요를 누르면 `type = 6`, 장바구니에 담으면 `type = 8`. 이런 식으로 유저가 서비스에서 뭔가 행동할 때마다 한 줄씩 쌓인다.

```sql
-- 대충 이런 느낌이다
INSERT INTO ActionLog (userId, productId, storeId, type, createDate)
VALUES (12345, 80001, 903, 5, NOW());
```

문제는 이게 **매일 수십만 건**씩 쌓인다는 것이다. 서비스를 몇 년 운영하다 보니 어느새 **수십억 건**이 되어 있었다. 이 정도 규모가 되면 아무리 단순한 `SELECT`도 가볍지 않다.

---

## 왜 1시간이나 걸렸을까?

문제의 쿼리를 다시 한번 보자.

```sql
SELECT userId
FROM ActionLog
WHERE type IN (8, 6)
  AND createDate >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
GROUP BY userId
HAVING SUM(CASE WHEN type = 6 THEN 1 ELSE 0 END) >= 5
    OR SUM(CASE WHEN type = 8 THEN 1 ELSE 0 END) >= 3;
```

얼핏 보면 평범한 쿼리다. `type`으로 필터링하고, `createDate`로 기간을 잡고, `GROUP BY`로 유저별 집계. 교과서적이다.

그런데 `EXPLAIN`을 찍어보는 순간 문제가 보였다.

```
type: ALL
rows: 3000000000+
```

**Full Table Scan.** 30억 건을 처음부터 끝까지 다 읽고 있었다.

---

## Full Table Scan이 뭔가요?

데이터베이스에서 데이터를 찾는 방법은 크게 두 가지다.

**첫 번째는 인덱스 스캔(Index Scan)**이다. 도서관에서 책을 찾을 때 색인 카드를 먼저 뒤지는 것과 같다. "아, 이 책은 3층 B열 47번째에 있구나" — 바로 찾아간다.

**두 번째는 풀 테이블 스캔(Full Table Scan)**이다. 색인 카드 같은 건 무시하고, 1층부터 꼭대기 층까지 모든 책장을 하나하나 훑으면서 "이 책 맞나? 아닌데. 이건? 이것도 아닌데."를 반복하는 것이다.

30억 건짜리 테이블에서 풀 테이블 스캔을 하고 있었으니, 1시간이 걸린 게 오히려 대견한 수준이었다.

### 근본 원인: createDate 인덱스가 없었다

기존에 ActionLog 테이블에는 인덱스가 9개나 있었다. `userId`, `productId`, `storeId`, `type` 등등. 그런데 정작 **기간 조회의 핵심인 `createDate`에는 인덱스가 없었다.**

대부분의 분석 쿼리가 "최근 N개월" 같은 기간 조건을 달고 있는데, 그 조건을 빠르게 걸러낼 방법이 아예 없었던 것이다. `type` 인덱스는 있었지만, `type`의 종류가 10~15개 정도밖에 안 되어서(카디널리티가 낮아서) 인덱스를 타도 걸러지는 양이 별로 없었다.

---

## B-Tree: 인덱스가 빠른 진짜 이유

여기서 잠깐. "인덱스를 추가하면 빨라진다"는 건 많이 들어봤을 것이다. 그런데 **왜** 빨라지는 걸까? 이걸 이해하려면 인덱스의 실체인 **B-Tree**를 알아야 한다.

### 전화번호부로 이해하기

전화번호부를 생각해보자. 30억 명이 수록된 전화번호부에서 "김시윤"을 찾는다고 해보자.

**방법 1: 처음부터 한 명씩 읽기 (= Full Table Scan)**

1페이지부터 시작해서 "강OO? 아니야. 고OO? 아니야. 구OO? 아니야..." 를 30억 번 반복한다. 이게 지금 우리 쿼리가 하고 있던 일이다.

**방법 2: 색인을 타고 가기 (= Index Scan)**

"ㄱ" 섹션으로 간다. → "김" 섹션으로 간다. → "김시" 구간으로 간다. → "김시윤" 찾았다. 3~4번이면 끝이다.

### B-Tree 구조

데이터베이스의 인덱스가 바로 이 색인 역할을 하는데, 그 내부 구조가 **B-Tree(Balanced Tree)**다.

```
                    [루트 노드]
                   /     |     \
            [10억]    [20억]    [30억]
           /  |  \   /  |  \   /  |  \
         [...]  [...]  [...]  [...]  [...]  ← 리프 노드 (실제 데이터 위치)
```

핵심은 이거다:

- **균형 트리**다. 어떤 데이터를 찾든 트리의 깊이(=탐색 횟수)가 동일하다.
- 30억 건이어도 트리 깊이는 대략 **4~5단계**에 불과하다.
- 즉, 디스크를 4~5번만 읽으면 원하는 데이터의 위치를 알 수 있다.

수학적으로 표현하면 이렇다.

| 데이터 건수 | Full Scan (O(n)) | B-Tree (O(log n)) |
|-----------|-----------------|-------------------|
| 1,000 | 1,000번 | ~10번 |
| 1,000,000 | 1,000,000번 | ~20번 |
| 1,000,000,000 | 1,000,000,000번 | ~30번 |
| **3,000,000,000** | **30억번** | **~32번** |

30억 건을 30억 번 읽는 것과, 32번 읽는 것. 이 차이가 **1시간 vs 수십 초**의 차이를 만든다.

### 그래서 우리한테 필요한 건

ActionLog 테이블에 `createDate` 인덱스가 없었다는 건, 기간 조회를 할 때마다 **30억 권짜리 전화번호부를 1페이지부터 넘기고 있었다**는 것과 같다. 색인 탭 하나만 붙이면 되는 일이었다.

---

## Phase 1: 인덱스 최적화

### 현재 상태 파악

최적화의 첫 걸음은 현재 상태를 정확히 파악하는 것이다. 다음 작업들을 먼저 진행했다.

**1) 기준 쿼리 5개 선정**

개선 효과를 숫자로 증명하려면 "Before ↔ After"를 비교할 기준이 필요하다. 실제로 자주 사용되는 패턴을 골라 5개의 벤치마크 쿼리를 정했다.

| # | 쿼리 설명 | Before |
|---|----------|--------|
| 1 | 6개월간 좋아요/장바구니 유저 집계 | **1시간+** |
| 2 | 최근 1개월 상품 클릭 수 | TBD |
| 3 | 특정 유저 행동 타임라인 | TBD |
| 4 | 일별 타입별 집계 | TBD |
| 5 | 브랜드별 클릭 수 (기간) | TBD |

**2) 인덱스 전수 조사**

5개 레포지토리에 흩어져 있는 ActionLog 관련 쿼리를 전부 찾아서, 어떤 인덱스가 실제로 사용되는지 매핑했다. 이게 꽤 중요한 작업이었는데, 인덱스를 무작정 추가하기 전에 기존 인덱스가 제 역할을 하고 있는지부터 파악해야 했기 때문이다.

결과가 꽤 재미있었다.

| 인덱스 | 상태 | 비고 |
|--------|------|------|
| userId, productId, storeId, type | ✅ 활발히 사용 | SELECT WHERE에서 사용 |
| visitorId, searchWordId | ✅ scheduler에서 사용 | 검색어 통계 쿼리 |
| productOptionId | ⚠️ JOIN에서만 사용 | WHERE 조건이 아님 |
| **eventId** | ❌ INSERT만 | SELECT 없음 |
| **pageView** | ❌ INSERT만 | SELECT 없음 |

`eventId`와 `pageView` 인덱스는 어디서도 조회에 활용되지 않고 있었다. 인덱스는 읽기를 빠르게 해주지만, **쓰기를 느리게 만든다**. 수십억 건이 INSERT되는 테이블에서 아무도 안 쓰는 인덱스가 매번 갱신되고 있었던 것이다. 제거 후보로 분류했다.

### 인덱스 추가: 무엇을, 왜

핵심은 간단했다. **`createDate` 인덱스를 추가하는 것.** 다만 무작정 추가하는 게 아니라, 전략적으로 접근했다.

```sql
-- 1순위: createDate 단독 인덱스
ALTER TABLE ActionLog
ADD INDEX idx_createDate (createDate),
ALGORITHM=INPLACE, LOCK=NONE;

-- 2순위: type + createDate 복합 인덱스
ALTER TABLE ActionLog
ADD INDEX idx_type_createDate (type, createDate),
ALGORITHM=INPLACE, LOCK=NONE;
```

여기서 `ALGORITHM=INPLACE, LOCK=NONE`이 중요하다. 이건 MySQL의 **Online DDL** 기능이다. 쉽게 말해서, 테이블에 락을 걸지 않고 인덱스를 추가할 수 있다는 뜻이다. 수십억 건짜리 프로덕션 테이블에 인덱스를 추가하면서 서비스가 멈추면 안 되니까.

### 왜 복합 인덱스도 추가했을까?

`createDate` 단독 인덱스만으로도 기간 조회는 빨라진다. 하지만 우리 쿼리 대부분이 `WHERE type = ? AND createDate >= ?` 형태였다. 이 경우 복합 인덱스가 있으면 MySQL이 **인덱스 하나로 두 조건을 동시에 걸러낼 수 있다.**

```
idx_createDate만 있을 때:
  1. createDate로 6개월치 필터링     ← 인덱스 사용 ✅
  2. 그 중에서 type 필터링            ← 추가 스캔 필요 ⚠️

idx_type_createDate가 있을 때:
  1. type = 8이면서 6개월 이내        ← 인덱스 하나로 끝 ✅✅
```

복합 인덱스에서 컬럼 순서가 `(type, createDate)`인 이유도 있다. B-Tree 안에서 데이터가 **왼쪽 컬럼 기준으로 먼저 정렬**되고, 같은 값 내에서 오른쪽 컬럼으로 정렬된다.

```
B-Tree 내부 (type, createDate) 정렬 순서:

type=5, 2024-01-01
type=5, 2024-01-02
type=5, 2024-01-03
...
type=6, 2024-01-01   ← type=6 구간 시작
type=6, 2024-01-02
type=6, 2025-10-21   ← 여기서부터 6개월 이내
type=6, 2025-10-22
...
type=8, 2024-01-01   ← type=8 구간 시작
type=8, 2025-10-21   ← 여기서부터 6개월 이내
type=8, 2025-10-22
...
```

`WHERE type IN (8, 6) AND createDate >= 6개월 전` 쿼리는 이 정렬된 B-Tree에서 **type=6 구간의 최근 6개월 + type=8 구간의 최근 6개월** 딱 두 범위만 읽으면 된다. 30억 건 전체를 훑는 것과는 차원이 다르다.

---

## Phase 1 결과

인덱스를 추가하고, 프로덕션 read replica에서 같은 쿼리를 돌려봤다.

DataGrip 콘솔 하단에 찍힌 실행 시간:

```
console_69  51 s
```

**1시간+ → 51초. 약 70배 개선.**

인덱스 두 개 추가한 것뿐인데, 70배 차이가 난다. B-Tree의 힘이다.

다만 51초가 최종은 아니다. 인덱스가 범위를 잡아줬지만, 매칭된 수천만 건의 실제 데이터를 디스크에서 읽어야 하고, `GROUP BY userId`로 전부 집계해야 결과가 나온다. 여기서 더 줄이려면 파티셔닝이 필요하다.

---

다음 편에서는 파티셔닝 전 작업을 진행한다. 쿼리의 WHERE 절에 파티션 키를 반드시 포함시키는 작업이다.

> 시리즈
> - **수십억 row 테이블 최적화하기 (1)** ← 현재 글
> - [수십억 row 테이블 최적화하기 (2)](/blog/actionlog-optimization-2)
> - [수십억 row 테이블 최적화하기 (3)](/blog/actionlog-optimization-3)
