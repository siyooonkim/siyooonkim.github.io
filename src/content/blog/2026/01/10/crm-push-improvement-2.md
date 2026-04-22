---
title: 'MSA 구조에서 CRM 푸시 개선하기 (2)'
description: ''
pubDate: '2026-01-10'
category: '개발일지'
tags: []
draft: true
---

[이전 편](/posts/2026/01/10/crm-push-improvement-1)에서 문제, 스펙, Redis/DB 저장 구조를 정리했다. 이번 편에서는 분산 락, 3일 체인 동작, 예외 처리를 다룬다.

---

## 분산 락

### 유저 단위 락

처음엔 상품 단위 락을 생각했다. 같은 상품을 두 워커가 동시에 처리하면 안 되니까. 하지만 문제는 거기가 아니었다.

상품 A와 상품 B가 동시에 할인되면, 상품 단위 락으로는 서로 다른 키를 잡는다. 두 워커가 각각 락을 획득하고, 같은 유저에게 푸시를 2건 보낸다.

보호해야 하는 건 상품이 아니라 유저당 발송 횟수다. 락 키를 유저 단위로 잡았다.

```ts
flarelane-dispatch-lock:{userId}
```

한 유저에 대해서는 무조건 직렬 처리한다. 병렬성이 떨어지지만, 동시에 100개 상품이 할인되는 극단적 상황보다 한 유저가 같은 날 푸시를 2번 받는 게 훨씬 나쁘다.

### 비관적 락

낙관적 락은 "일단 처리하고 나중에 충돌 감지"다. 푸시는 외부 시스템에 나간 뒤에는 되돌릴 수 없다. DB에 unique constraint를 걸어도 이미 발송은 끝난 뒤라 늦다. 충돌을 사전에 막아야 하는 작업이라 비관적 락으로 갔다.

### TTL

정상 처리는 2~5초 안쪽이지만, 네트워크 지연이나 외부 API 지연을 감안해 20초로 잡았다. 너무 짧으면 TTL 만료 후 다른 워커가 들어와서 중복 발송이 생기고, 너무 길면 워커가 죽었을 때 복구가 느려진다.

```ts
export const FLARELANE_DISPATCH_LOCK_TTL_MS = 20 * 1000;
```

### 락 경합과 인프라 장애 구분

초기 코드에서 위험했던 부분:

```ts
try {
  const lock = await this.redis.lock(key);
} catch (error) {
  return null; // 모든 예외를 락 실패로 처리
}
```

이러면 Redis 연결 실패도 "다른 워커가 처리 중"으로 보인다. 실제로는 두 종류다.

- **락 경합**: 다른 워커가 이미 잡고 있음. 정상이라 스킵하면 됨
- **인프라 장애**: Redis 연결 실패, 타임아웃. 비정상이라 알림이 필요함

```ts
private isLockContentionError(error: unknown): boolean {
  return (
    error instanceof ResourceLockedError ||
    (error instanceof Error && error.name === 'ResourceLockedError')
  );
}
```

### 락 실패 시 candidate 방치 방지

Worker A가 락을 잡고 발송을 완료한다. Worker B는 같은 유저의 다른 상품 candidate를 저장했지만 락을 못 잡아서 스킵한다. B의 candidate가 Redis에 남아있는데 아무도 다시 안 주워간다.

락 획득에 실패한 유저에 대해 pending job이 없으면 다음 delayed job을 예약하도록 했다.

```ts
await Promise.allSettled(
  lockFailedUserIds.map(async (userId) => {
    const hasPendingJob = await this.nextSendJobService.hasPendingJob(userId);
    if (!hasPendingJob) {
      await this.nextSendJobService.scheduleNext(userId);
    }
  }),
);
```

### 2차 방어

분산 락으로 99%는 막지만 TTL 만료 직전 워커가 느려지면 두 워커가 동시에 발송할 수 있다. 완벽한 차단보다 이상 징후를 빨리 감지하는 구조가 현실적이다.

발송 기록 저장 시 이전 기록과 비교해서 중복이면 Slack으로 알린다.

```ts
if (previousRecord && previousRecord.after >= after) {
  await this.slackService.notifyDuplicateSend({ userId, productId });
}
```

---

## 3일 체인 동작

유저가 장바구니에 A, B, C 상품을 담고 있고, 세 개가 동시에 할인됐다고 하자.

```
Day 0:
  A: before=40%, after=50% → gap=10
  B: before=20%, after=30% → gap=10
  C: before=10%, after=35% → gap=25

  → 세 상품 전부 candidate record에 저장
  → current 조회 → gap 재계산 → C(gap=25)가 1위
  → C 발송
  → sent record 저장
  → 3일 뒤 delayed job 예약

Day 3 (delayed job 실행):
  → candidate 재조회: A, B 남아있음
  → current 재조회: A(current=50%, gap=10), B(current=28%, gap=8)
  → A(gap=10) > B(gap=8) → A 발송
  → 남은 후보 B → 또 3일 뒤 예약

Day 6 (delayed job 실행):
  → candidate 재조회: B 남아있음
  → current 재조회: B(current=25%, gap=5)
  → B 발송
  → 남은 후보 없음 → 종료
```

매번 발송 시점에 current를 다시 조회한다. Day 0에 계산한 gap이 Day 3에도 유효하리란 보장이 없다.

---

## 예외 처리

발송 시점에 다시 조회하기 때문에 대부분의 예외는 자동으로 걸러진다.

### 할인 원복

```
Day 0: A(before=40%, after=50%) → candidate 저장
Day 2: A 할인 종료, 가격 원복 → current=40%

Day 3 발송 시점:
  current(40%) <= before(40%) → 발송 안 함 → 다음 후보로
```

### 장바구니 삭제 / 구매

```
Day 0: B 발송 대기 중
Day 1: 유저가 B를 장바구니에서 삭제 (또는 구매)

Day 3: 장바구니 재조회 → B 없음 → 후보 제외 → 다음으로
```

### 품절 / 판매중지

```
Day 3: B 판매중지 상태 → isDiscounting() false → 후보 제외
```

### 대기 중 더 큰 할인 후보 등장

```
Day 0: A(gap=10) 발송, 3일 뒤 예약
Day 2: D(before=20%, after=50%) 새 이벤트 발생
       → candidate record 저장
       → pending job이 이미 있음 → 즉시 발송 스킵

Day 3:
  B: current=30%, gap=10
  D: current=48%, gap=28
  → D(gap=28) > B(gap=10) → D 발송
```

Day 2에 새 이벤트가 와도 즉시 보내지 않는다. pending job이 이미 있으니까. Day 3에 전체 후보를 재계산하면 D가 자연스럽게 선택된다.

### 1000개 동시 할인

```
Day 0: 유저에게 할인 이벤트 100개 동시 도착
  → 첫 번째만 락 획득 성공
  → 100개 전부 candidate record에 저장
  → gap 기준 1위 발송 + 3일 뒤 예약
  → 나머지 99개: 락 실패 or pending job 존재 → 스킵
```

100개가 동시에 와도 1건만 발송된다. 나머지는 candidate에 쌓여 있다가 3일 뒤, 6일 뒤, 9일 뒤... 순서대로 나간다.

---

## 전체 흐름

```
할인 이벤트 발생
    │
    ▼
장바구니 유저별 candidate record 저장 (Redis)
    │
    ▼
유저 단위 분산 락 획득 시도
    │
    ├── 성공 + pending job 없음
    │       → gap 기준 1위 발송
    │       → sent record 저장
    │       → 3일 뒤 delayed job 예약
    │
    ├── 성공 + pending job 있음
    │       → 스킵 (기존 예약이 처리할 것)
    │
    └── 실패
            → 스킵 (다른 워커 처리 중)
            → pending job 없으면 다음 job 예약

3일 뒤 delayed job 실행
    │
    ▼
유저 단위 락 획득 → candidate 재조회 → current 재조회 → gap 재계산
    │
    ├── 후보 있음 → 1위 발송 + 다음 후보 있으면 또 3일 뒤 예약
    └── 후보 없음 → 종료
```

---

## Bull Queue vs RabbitMQ vs Kafka

이 작업은 기존 Bull Queue + Redis 스택에서 해결했다. 끝나고 다른 메시지 큐로 했으면 어땠을지 찾아봤다.

### Bull Queue

우리가 쓴 방식이다. Producer가 큐에 job을 넣으면 Processor가 꺼내서 처리한다.

```
Producer → Redis Queue → Processor
```

- **주체**: Processor. job이 오면 처리한다.
- **delayed job**: Redis sorted set으로 구현. 타이머가 아니라 타임스탬프 비교라서 워커/Redis 재시작에도 유지된다.
- **적합한 상황**: 단일 서비스 내 비동기 처리, delayed/scheduled job, 소규모 트래픽.

### RabbitMQ

메시지 브로커가 중앙에 있고, Producer가 메시지를 보내면 Broker가 Consumer에게 push한다.

```
Producer → Broker (Exchange → Queue) → Consumer
```

- **주체**: Broker가 Consumer에게 push. Consumer는 받아서 처리.
- **특징**: 라우팅이 유연하다. Exchange 타입(direct, topic, fanout)으로 메시지를 여러 큐에 분배할 수 있다. Dead Letter Queue로 실패 메시지 관리도 체계적이다.
- **적합한 상황**: 서비스 간 메시지 전달, 복잡한 라우팅이 필요할 때, 메시지 순서 보장이 중요할 때.

### Kafka

Producer가 토픽에 이벤트를 발행하면 Consumer Group이 파티션별로 pull한다.

```
Producer → Topic (Partitions) → Consumer Group
```

- **주체**: Consumer. 직접 토픽에서 pull해서 가져간다.
- **특징**: 이벤트가 삭제되지 않는다. Consumer가 offset을 관리하면서 같은 이벤트를 여러 번 읽을 수 있다. 처리량이 압도적이다.
- **적합한 상황**: 대규모 이벤트 스트리밍, 여러 서비스가 같은 이벤트를 구독, 이벤트 리플레이가 필요할 때.

### 비교

| 기준 | Bull Queue | RabbitMQ | Kafka |
|------|-----------|----------|-------|
| 인프라 | Redis (이미 있음) | 별도 브로커 필요 | 별도 클러스터 필요 |
| delayed job | 네이티브 지원 | TTL + DLQ로 우회 | 직접 구현 |
| 트래픽 규모 | 소~중 | 중~대 | 대규모 |
| 복잡도 | 낮음 | 중간 | 높음 |

단일 서비스 내에서 delayed job을 쓰는 케이스라 Bull Queue가 맞았다. 여러 서비스가 할인 이벤트를 구독해야 하는 구조였다면 RabbitMQ나 Kafka를 검토했을 것이다.

---

## 정리

gap 정의, 발송 시점 재계산, 원복 판단, 재발송 조건. 이것들이 확정되고 나서야 구현이 시작됐다. 롤백이 불가능한 외부 작업(푸시 발송)을 다룰 때는 완벽한 차단보다 관측 가능성이 중요하다. 분산 락으로 99%를 막고, 나머지 1%는 Slack 알림으로 잡는 구조가 현실적이었다.

> 시리즈
> - [MSA 구조에서 CRM 푸시 개선하기 (1)](/posts/2026/01/10/crm-push-improvement-1)
> - **MSA 구조에서 CRM 푸시 개선하기 (2)** ← 현재 글
