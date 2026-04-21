---
title: '인덱스를 달았는데 왜 안 타지? — ActionLog 최적화 (2)'
description: '파티셔닝을 준비하다 발견한 충격적인 사실 — 쿼리 23개 중 61%가 createDate 조건이 없었다. DATE() 함수의 함정과 Sargable 쿼리 개념을 정리했습니다.'
pubDate: '2026-04-21'
category: '데이터베이스'
tags: ['database', 'mysql', 'index', 'query-optimization', 'sargable', 'partition-pruning']
draft: false
---

[이전 편](/blog/db-partitioning-performance)에서 수십억 건짜리 ActionLog 테이블에 인덱스를 추가해서 1시간 → 51초로 줄인 이야기를 했다. 70배 개선이면 꽤 대단한 성과다.

자연스럽게 다음 단계를 생각하게 됐다. "파티셔닝을 하면 더 빨라지지 않을까?"

결론부터 말하면, 파티셔닝보다 먼저 해결해야 할 문제가 있었다. 그리고 그걸 발견하지 못했다면, 파티셔닝은 **오히려 성능을 나빠지게 만들 뻔했다.**

---

## 파티셔닝이 뭔가요?

본격적인 이야기 전에, 파티셔닝이 뭔지 짚고 넘어가자.

파티셔닝은 하나의 거대한 테이블을 **여러 개의 작은 조각(파티션)으로 나누는 기법**이다.

비유하자면 이렇다. 도서관에 책이 30억 권이 있다고 해보자. 한 층에 30억 권을 다 넣어두면 원하는 책을 찾기가 힘들다. 하지만 **출판 연월별로 층을 나눠두면** — "2025년 1월에 나온 책이요" 했을 때 해당 층만 찾으면 된다. 나머지 층은 쳐다볼 필요도 없다.

MySQL에서는 이걸 **파티션 프루닝(Partition Pruning)**이라고 한다. 쿼리 조건에 맞는 파티션만 스캔하고, 나머지는 아예 건너뛰는 것이다.

```
파티셔닝 전:
┌──────────────────────────────────────┐
│         ActionLog (30억 건)           │  ← 전부 스캔
└──────────────────────────────────────┘

파티셔닝 후 (월별):
┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐ ...
│202401││202402││202403││ ...  ││202504│
│ skip ││ skip ││ skip ││      ││ scan │ ← 최근 6개월만
└──────┘└──────┘└──────┘└──────┘└──────┘
```

수십억 건의 테이블도 월별로 나누면, 한 달치 파티션은 수천만 건 정도다. 6개월 조회면 6개 파티션만 보면 된다. 스캔 범위가 극적으로 줄어든다.

좋아 보인다. 바로 적용하면 되겠지? 라고 생각했는데...

---

## 예상 못한 발견

파티셔닝을 설계하면서, 한 가지 중요한 전제를 확인해야 했다.

> **파티션 프루닝이 작동하려면, 쿼리의 WHERE 절에 파티션 키(`createDate`)가 반드시 포함되어야 한다.**

없으면? MySQL은 **모든 파티션을 다 스캔한다.** 파티셔닝 안 한 것보다 오히려 느려질 수도 있다. 파티션마다 따로 열고 닫는 오버헤드가 추가되니까.

"설마 createDate 없는 쿼리가 있겠어?" 싶었다. 기간 조회가 기본인 테이블인데.

그래서 기존 쿼리들을 전수 조사했다. 5개 레포지토리에 흩어져 있는 ActionLog SELECT 쿼리 23개를 전부 찾아서 분석했다.

결과는 좀 충격적이었다.

```
전체 SELECT 쿼리:     23개
createDate 조건 있음:   4개 (17%)   ✅
조건부 (동적 추가):      5개 (22%)   ⚠️
createDate 조건 없음:  14개 (61%)   ❌
```

**61%. 14개의 쿼리가 `createDate`를 WHERE에 포함하지 않고 있었다.**

이 상태에서 파티셔닝을 적용하면 과반수의 쿼리가 전체 파티션 스캔을 하게 된다. 최적화는커녕 오히려 성능이 나빠질 수 있는 상황이었다.

---

## 쿼리를 하나하나 뜯어보니

전수 조사를 하면서 여러 가지 재미있는(?) 패턴을 발견했다.

### CRITICAL — createDate 조건 자체가 없는 쿼리들

가장 심각한 건 아예 날짜 필터가 없는 쿼리들이었다.

```javascript
// store.repository.ts - getBrandListExcelDownload()
// 서브쿼리에서 ActionLog 전체를 스캔 중...
// 수십억 건 전체를요...
```

브랜드 리스트 엑셀 다운로드 기능인데, 내부적으로 ActionLog를 서브쿼리로 사용하면서 **아무 필터도 없었다.** 이 쿼리가 실행될 때마다 수십억 건을 풀스캔하고 있었던 것이다.

비슷한 패턴이 5개 레포에 걸쳐 6건이나 있었다.

| 레포 | 함수 | 문제 |
|------|------|------|
| admin-backend | `getUserAddAndRemoveCartAmountRows` | userId + type만 필터 |
| admin-backend | `getUserAddAndRemoveAndClickLikeProductAmountRows` | userId + type만 필터 |
| admin-backend | `getUserAddAndRemoveAndClickLikeBrandAmountRows` | userId + type만 필터 |
| monorepo | `findProductCountByActionLogType()` | id 범위만 필터 |
| monorepo | `getBrandListExcelDownload()` 서브쿼리 | **필터 전혀 없음** |
| monorepo | `findProcessingProductTracking()` x3 | id 범위만 필터 |

### HIGH — 함수 이름이 사기인 쿼리들

이건 좀 황당했다.

```javascript
// 함수 이름: getLikeStoreByDateRows
// "ByDate"라면서요...?
// 실제 WHERE 절: type = 6 AND userId = ?
// createDate? 없음. 😇
```

`getLikeStoreByDateRows`라는 이름에서 "ByDate"는 날짜별로 조회한다는 뜻일 텐데, 실제로는 날짜 필터가 없었다. 비슷한 패턴이 또 있었다.

```javascript
// 함수 이름: getProductClickByDateRows
// "ByDate"라면서요... (2)
// createDate 조건: 역시 없음
```

아마 처음 만들 때는 날짜 조건이 있었거나, 나중에 추가할 예정이었을 것이다. 하지만 현재는 함수 이름과 실제 동작이 완전히 괴리된 상태였다.

---

## DATE() 함수의 함정

전수 조사를 하면서 또 하나 발견한 문제가 있었다. 일부 쿼리에서 이런 패턴이 쓰이고 있었다.

```sql
-- 이렇게 쓰고 있었다 ❌
WHERE DATE(AL.createDate) >= CURDATE() - INTERVAL 30 DAY
```

얼핏 보면 문제없어 보인다. createDate에서 날짜만 뽑아서 비교하는 거니까. 하지만 이 쿼리는 **인덱스를 사용할 수 없다.**

### Sargable이 뭔가요?

데이터베이스에는 **Sargable(Search ARGument ABLE)**이라는 개념이 있다. 직역하면 "검색 인자로 사용 가능한"이라는 뜻인데, 쉽게 말하면 **인덱스를 탈 수 있는 조건인지 아닌지**를 구분하는 말이다.

핵심 규칙은 간단하다:

> **WHERE 절에서 컬럼에 함수를 씌우면, 그 컬럼의 인덱스를 사용할 수 없다.**

왜일까? B-Tree 인덱스에는 `createDate`의 **원래 값**이 저장되어 있다.

```
B-Tree 인덱스에 저장된 값:
2025-10-21 14:30:22
2025-10-21 15:12:08
2025-10-22 09:01:33
...
```

`WHERE createDate >= '2025-10-01'`이라고 하면, MySQL은 B-Tree에서 `2025-10-01` 위치를 바로 찾아갈 수 있다. 인덱스에 저장된 값과 비교 대상이 같은 형태니까.

하지만 `WHERE DATE(createDate) >= '2025-10-01'`이라고 하면? MySQL은 인덱스에 저장된 값(`2025-10-21 14:30:22`)을 먼저 `DATE()` 함수로 변환한 뒤 비교해야 한다. **모든 row에 대해 변환을 해야 하니까, 결국 전체를 다 읽는 것과 같다.**

```
Non-Sargable (인덱스 못 탐) ❌
WHERE DATE(createDate) >= '2025-10-01'
WHERE YEAR(createDate) = 2025
WHERE createDate + INTERVAL 1 DAY >= NOW()

Sargable (인덱스 탐) ✅
WHERE createDate >= '2025-10-01'
WHERE createDate >= '2025-10-01' AND createDate < '2025-10-02'
WHERE createDate >= DATE_SUB(NOW(), INTERVAL 30 DAY)
```

정리하면 이렇다:

- **컬럼을 가공하면** → Non-Sargable → 인덱스 못 탐 ❌
- **값을 가공하면** → Sargable → 인덱스 탐 ✅

`DATE(createDate) >= ?`는 컬럼을 가공하는 것이고, `createDate >= ?`는 값과 직접 비교하는 것이다.

### 수정 방법

```sql
-- Before ❌ (Non-Sargable)
WHERE DATE(AL.createDate) >= CURDATE() - INTERVAL 30 DAY

-- After ✅ (Sargable)
WHERE AL.createDate >= CURDATE() - INTERVAL 30 DAY
  AND AL.createDate < CURDATE() + INTERVAL 1 DAY
```

미세한 차이처럼 보이지만, 결과는 완전히 다르다. 전자는 인덱스를 무시하고 전체를 스캔하고, 후자는 인덱스를 타고 필요한 범위만 읽는다.

1편에서 열심히 인덱스를 추가해놨는데, 쿼리 쪽에서 `DATE()` 함수를 씌워버리면 그 인덱스를 못 쓰는 것이다. **무용지물.**

---

## Phase 1.5에서 한 일

결국 파티셔닝 전에 먼저 쿼리를 정비해야 했다. 이 작업을 Phase 1.5라고 불렀다.

### 1. CRITICAL — createDate 조건 추가 (6건)

날짜 조건이 아예 없는 쿼리들에 `createDate` 범위 조건을 추가했다. 대부분의 비즈니스 로직이 최근 N개월 데이터만 필요했기 때문에, 불필요하게 전체를 스캔할 이유가 없었다.

### 2. HIGH — 함수명과 동작 불일치 수정 (3건)

`ByDate`라는 이름에 걸맞게 실제로 날짜 필터를 추가하거나, 함수명을 실제 동작에 맞게 변경했다.

### 3. DATE() 함수 제거 (해당 쿼리 전부)

`DATE(createDate) = ?` 패턴을 전부 `createDate >= ? AND createDate < ?` 패턴으로 변경했다.

### 4. CONDITIONAL — 호출부 확인 (5건)

쿼리 자체에는 createDate가 없지만, 호출하는 쪽에서 동적으로 조건을 추가하는 경우가 있었다. 이건 하나하나 호출 체인을 추적해서 확인했다.

---

이 작업이 Phase 1보다 손이 훨씬 많이 갔다. 5개 레포지토리에 걸쳐 있는 쿼리들을 하나하나 찾아서 고쳐야 했으니까. 하지만 이걸 안 하고 파티셔닝을 했으면 오히려 성능이 나빠졌을 것이다.

수정 전후를 표로 정리하면 이렇다.

<div style="overflow-x: auto; margin: 2rem 0;">
<table style="width: 100%; border-collapse: collapse; text-align: center; font-size: 0.9rem;">
<tr>
<td style="padding: 1rem; background: #ff6b6b; color: white; border-radius: 8px;">
<strong>수정 전</strong><br/><br/>
23개 쿼리 중<br/>
✅ 4개만 인덱스 활용 가능<br/>
❌ 14개는 Full Scan<br/>
⚠️ 5개는 확인 필요
</td>
<td style="padding: 0.5rem; font-size: 1.5rem;">→</td>
<td style="padding: 1rem; background: #6bcb77; color: white; border-radius: 8px;">
<strong>수정 후</strong><br/><br/>
23개 쿼리 중<br/>
✅ 23개 전부 인덱스 활용 가능<br/>
✅ 파티션 프루닝 준비 완료
</td>
</tr>
</table>
</div>

---

## 이번 편의 교훈

이번 Phase 1.5에서 가장 크게 배운 건 이것이다.

**"인덱스를 추가하는 것보다, 그 인덱스를 제대로 쓸 수 있는 쿼리를 만드는 게 먼저다."**

Phase 1에서 인덱스를 추가하고 "이제 됐다" 싶었는데, 실제로는 61%의 쿼리가 그 인덱스를 활용조차 못 하고 있었다. 그리고 `DATE()` 함수처럼 미세한 차이가 인덱스 사용 여부를 완전히 갈라놓을 수 있다는 것도 알게 됐다.

만약 이 발견 없이 바로 파티셔닝으로 넘어갔다면? 14개 쿼리가 모든 파티션을 스캔하면서, 파티셔닝 전보다 오히려 느려지는 결과가 나왔을 것이다.

**최적화에서 가장 위험한 건 "빨라질 거야"라는 가정 하에 검증 없이 적용하는 것이다.**

---

## 다음 편 예고

쿼리 정비가 끝났다. 23개 쿼리 전부 인덱스를 활용할 수 있고, 파티션 프루닝도 제대로 동작할 수 있는 상태가 됐다.

이제 진짜 본게임이다.

다음 편에서는 **월별 파티셔닝 설계, PK 변경 이슈, 수십억 건을 무중단으로 마이그레이션하는 dual-write 전략**, 그리고 최종 성능 결과를 다룬다.

> 📖 시리즈
> - [1편: 수십억 건 테이블, 쿼리에 1시간이 걸린다](/blog/db-partitioning-performance)
> - **2편: 인덱스를 달았는데 왜 안 타지?** ← 현재 글
> - 3편: 파티셔닝으로 초 단위까지 끌어내리기 (준비 중)
