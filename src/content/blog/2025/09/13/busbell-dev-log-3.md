---
title: '답답해서 직접 만든 버스 알림 앱 (버스벨) 개발 기록 (3)'
description: '공공 API 연동, 어댑터 패턴, 알림 타이머, 서버 재시작 복원까지 백엔드 설계 과정을 정리한 기록입니다.'
pubDate: '2025-09-13'
updatedDate: '2025-09-13'
category: '개발일지'
tags: ['project', 'busbell', 'backend', 'nestjs', 'fcm', 'adapter-pattern']
draft: false
---

# '버스벨' 개발 (3) _ 백엔드 개발

지난 글에서 PRD와 Figma 디자인까지 만들었다. 화면은 3~4개면 충분하다는 결론이 나왔고, 이제 진짜 코드를 짤 차례다.

백엔드부터 시작한다. 앱이 호출할 API가 없으면 화면을 만들어봤자 껍데기니까.

## 💁 뭘 만들어야 하는가

버스벨의 백엔드가 해야 하는 일을 정리해봤다.

> 공공 API에서 버스 위치를 가져오고, 유저가 설정한 조건에 맞으면 푸시 알림을 쏜다.

한 줄로 쓰면 단순한데, 쪼개보면 네 덩어리다.

1. **버스 정보 조회** — 공공데이터 API에서 노선, 정류장, 실시간 위치, ETA를 가져온다
2. **알림 예약/관리** — 유저가 설정한 알림을 DB에 저장하고 상태를 관리한다
3. **타이머** — 버스 도착 시간을 추적하다가, 조건이 충족되면 푸시를 발송한다
4. **인증** — 회원가입, 로그인, JWT 토큰, FCM 토큰 관리

이 네 가지를 NestJS 모듈 단위로 나눠서 하나씩 만들어가기로 했다.

```text
src/
├── auth/            # 인증 (회원가입, 로그인, JWT)
├── busapi/          # 버스 정보 (검색, 노선, ETA)
│   ├── adapters/    # 서울/경기 어댑터
│   ├── services/    # 파사드 서비스
│   └── interfaces/  # 공통 인터페이스
├── notifications/   # 알림 (예약, 타이머, FCM 발송)
│   ├── services/
│   │   ├── notification.service.ts  # 예약 CRUD
│   │   ├── timer.service.ts         # ETA 기반 폴링
│   │   └── fcm.service.ts           # Firebase 푸시
│   └── entities/
├── users/           # 유저 프로필, 탈퇴
└── databases/       # DB 설정, 마이그레이션
```

## 💁 공공데이터 API — TAGO에서 시작해서 어댑터 패턴까지

버스 실시간 위치 데이터는 [공공데이터포털](https://data.go.kr)에서 가져온다.

처음에는 **TAGO API**(국토교통부 전국 버스 정보 시스템)를 썼다. 전국 버스를 하나의 API로 조회할 수 있어서 편할 줄 알았다.

근데 써보니 문제가 있었다. 실시간 위치 데이터의 **갱신 주기가 느리고**, 도착 예정 시간의 정확도도 떨어졌다. 내가 매일 타는 9507번 버스로 테스트해보니 ETA가 실제 도착과 5분 넘게 차이 나는 경우가 잦았다. 5분 전 알림 서비스인데 ETA가 5분 틀리면 의미가 없었다.

그래서 **지역별 API를 직접 연동**하는 방향으로 바꿨다.

- 서울: TOPIS API — 서울시 직접 운영, 갱신 빠름
- 경기: GBIS v2 API — 경기도 직접 운영, 정확도 높음

TAGO 어댑터 670줄을 통째로 삭제하고, 서울/경기 어댑터를 새로 만들었다.

문제는 이 두 API가 완전히 다른 서비스라는 점이었다. URL도 다르고, 응답 필드명도 다르고, 에러 코드도 다르다. 처음에는 `if` 문으로 분기 처리하다가 금방 코드가 지저분해져서, 어댑터 패턴으로 분리했다.

```text
BusApiService (파사드)
  ├── SeoulAdapter    → 서울 TOPIS API 호출
  └── GyeonggiAdapter → 경기 GBIS API 호출
```

![서울/경기 어댑터 구조](/images/posts/busbell-3/adapter-architecture.webp)

핵심은 **추상화**다.

서울 API는 응답이 JSON인데 경기도는 XML이다. 필드명도 서울은 `busRouteId`, 경기도는 `routeId`다. 도착 시간도 서울은 초 단위, 경기도는 분 단위다. 이런 차이를 호출하는 쪽에서 매번 알게 만들고 싶지 않았다.

그래서 `BusSearchResult`, `ArrivalInfo`, `LiveData` 같은 **공통 인터페이스**를 먼저 정의하고, 각 어댑터가 자기 지역 API 응답을 이 공통 형태로 변환하도록 했다.

```ts
interface ArrivalInfo {
  routeId: string;
  routeName: string;
  arrivals: {
    vehicleNo: string;
    remainingStops: number;
    etaMinutes: number;
  }[];
}
```

경기도 어댑터는 `predictTime1`을 그대로 넣고, 서울 어댑터는 초 단위 응답을 60으로 나눠 넣는다. `BusApiService`는 `cityCode`만 보고 어떤 어댑터를 쓸지 결정한다. 결과적으로 앱은 서울/경기를 구분할 필요 없이 같은 형태의 데이터를 받는다.

이게 추상화의 핵심이라고 생각했다. **몰라도 되는 것은 몰라도 되게 만드는 것.**

### Redis를 걷어낸 이유

캐시는 처음에는 Redis로 구현했다. 근데 Railway에서 Redis를 쓰려면 별도 인스턴스를 띄워야 하고, 무료 플랜에서는 제한도 있다. 사이드 프로젝트에 매달 Redis 비용을 내고 싶지 않았다.

생각해보면 버스벨의 캐시 데이터는 노선 개요(6시간 TTL)와 정류장 목록(24시간 TTL)이 대부분이다. 데이터 양도 적고, 서버가 재시작되면 다시 채우면 된다.

그래서 NestJS의 `cache-manager` 기반 **인메모리 캐시**로 갈아탔다. Redis 의존성을 제거하니 Docker 이미지도 가벼워졌고, 인프라 구성이 단순해졌다. 이것도 오버엔지니어링을 걷어낸 사례였다.

### 공공 API의 현실: 429 Rate Limit

경기도 API는 초당 호출 제한이 있어서 검색할 때 여러 건을 동시에 날리면 429가 떨어졌다. 그래서 Axios 인터셉터에 **지수 백오프** 재시도 로직을 넣었다.

```ts
this.httpClient.interceptors.response.use(undefined, async (error) => {
  if (error.response?.status === 429 && config._retryCount < 3) {
    config._retryCount = (config._retryCount || 0) + 1;
    const delay = Math.pow(2, config._retryCount) * 1000;
    await new Promise((r) => setTimeout(r, delay));
    return this.httpClient.request(config);
  }
  return Promise.reject(error);
});
```

노선 정보나 정류장 목록처럼 자주 안 바뀌는 데이터는 캐시에 넣어서 API 호출 자체를 줄였다.

## 💁 핵심 로직: 알림 타이머

버스벨에서 가장 고민을 많이 한 부분이다.

처음에는 `@nestjs/schedule`의 크론잡으로 1분마다 전체 알림을 순회하면서 조건을 체크하려고 했다. 그런데 알림이 10개면 1분마다 10번씩 공공 API를 호출해야 하고, 대부분은 아직 도착 시간이 한참 남은 상태였다.

그래서 **알림마다 독립적인 타이머**를 돌리는 방식으로 바꿨다.

예를 들어 "5분 전 알림"을 설정했고 현재 버스 ETA가 20분이면:

- 20분 - 5분 = 15분 → 15분 뒤에 다시 확인하도록 `setTimeout`
- 15분 후 ETA 재조회 → 조건 충족 시 FCM 발송
- 실패 시 30초 후 재시도, 최대 3번

이렇게 하면 불필요한 API 호출이 확 줄어든다. 공공 API 호출 제한도 아낄 수 있다.

### 1) 알림 예약 흐름

![알림 예약 흐름](/images/posts/busbell-3/notification-reserve-flow.png)

유저가 알림을 예약하면 바로 저장하는 게 아니라, 먼저 현재 ETA를 검증한다. 버스가 이미 3분 후 도착인데 "5분 전 알림"을 설정하면 의미가 없기 때문이다.

### 2) 타이머 폴링 → 푸시 발송

![타이머 폴링과 푸시 발송 흐름](/images/posts/busbell-3/polling-push-flow.png)

### 3) FCM 실패 시 재시도

![FCM 실패 재시도 흐름](/images/posts/busbell-3/fcm-retry-flow.png)

FCM 발송은 네트워크 문제나 토큰 만료 등으로 실패할 수 있다. 그래서 최대 3회, 30초 간격으로 재시도하고, 3번 모두 실패하면 `Expired` 처리했다.

### 4) 서버 재시작 시 타이머 복원

Railway 같은 플랫폼은 서버가 언제든 재시작될 수 있다. 메모리에만 타이머를 들고 있으면 재시작 순간 예약된 알림이 전부 날아간다.

그래서 `onModuleInit`에서 DB의 `Reserved` 상태 알림을 조회해 타이머를 복원하도록 했다.

```ts
async onModuleInit() {
  const reserved = await this.notificationRepo.find({
    where: { status: NotificationStatus.Reserved },
  });

  for (const noti of reserved) {
    await this.startPollingForNotification(noti.id, randomUUID());
  }
}
```

완벽한 방식은 아니다. Redis나 메시지 큐를 쓰면 더 견고해질 수 있다. 하지만 1인 사이드 프로젝트에서는 이 정도가 적절한 선이라고 판단했다.

## 💁 API 설계

Swagger로 문서화까지 정리해뒀다. 주요 엔드포인트는 아래와 같다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/bus/search?keyword=9507` | 버스 번호 검색 |
| GET | `/bus/overview` | 노선 개요 |
| GET | `/bus/route-stops` | 노선별 정류장 목록 |
| GET | `/bus/realtime-info` | 실시간 차량 위치 |
| GET | `/bus/eta` | 특정 정류장 도착 ETA |
| POST | `/notifications` | 알림 예약 생성 |
| GET | `/notifications` | 내 활성 알림 목록 |
| DELETE | `/notifications/:id` | 알림 취소 |

인증은 JWT access + refresh 토큰 구조로 구성했고, 로그인 시 FCM 토큰도 함께 저장했다. 그래서 같은 계정으로 여러 기기에서 알림을 받을 수 있도록 열어뒀다.

## 💁 다음 글에서는

백엔드 API가 완성됐으니, 이제 이 API를 호출할 앱을 만들 차례다. 다음 글에서는 React Native로 버스 검색 → 노선 상세 → 알림 설정까지의 화면을 어떻게 구현했는지 정리할 예정이다.
