---
title: '답답해서 직접 만든 버스 알림 앱 (버스벨) 개발 기록 (2)'
description: ''
pubDate: '2025-09-06'
updatedDate: '2025-09-06'
category: '사이드 프로젝트'
tags: ['project', 'busbell', 'backend', 'nestjs', 'fcm', 'adapter-pattern']
draft: false
---

지난 글에서 PRD와 Figma 디자인까지 만들었다. 
(어려운 서비스가 아니라서 화면은 3~4개면 충분할 것 같다.)

## 💁 뭘 만들어야 하는가

버스벨의 백엔드의 요구 사항을 정리해보았다. 

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

## 💁 어댑터 패턴으로 공공 API 추상화하기

버스 실시간 위치 데이터는 [공공데이터포털](https://data.go.kr)에서 가져온다.

- 서울: TOPIS API — 서울시 직접 운영
- 경기: GBIS v2 API — 경기도 직접 운영


문제는 이 두 API가 완전히 다른 서비스라는 점이었다. URL도 다르고, 응답 필드명도 다르고, 에러 코드도 다르다. 
처음에는 `if` 문으로 분기 처리를 할까 했다가, 
코드가 금방 지져분해지는 경험을 토대로,, 어댑터 패턴으로 분리했다.

```text
BusApiService (파사드)
  ├── SeoulAdapter    → 서울 TOPIS API 호출
  └── GyeonggiAdapter → 경기 GBIS API 호출
```

### 여기서 핵심은 **추상화**다.

서울 API는 응답이 JSON인데 경기도는 XML이다. 
필드명도 서울은 `busRouteId`, 경기도는 `routeId`다. 
도착 시간도 서울은 초 단위, 경기도는 분 단위다. 

이런 차이를 호출하는 쪽에서 알 필요 없도록 설계하는게 중요하다고 판단했고, `BusSearchResult`, `ArrivalInfo`, `LiveData` 같은 **공통 인터페이스**를 먼저 정의하여 각 어댑터가 자기 지역 API 응답을 이 공통 형태로 변환하도록 했다.

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

**몰라도 되는 것은 몰라도 되게 만드는 것.**

경기도 어댑터는 `predictTime1`을 그대로 넣고, 서울 어댑터는 초 단위 응답을 60으로 나눠 넣는다. `BusApiService`는 `cityCode`만 보고 어떤 어댑터를 쓸지 결정한다. 결과적으로 앱은 서울/경기를 구분할 필요 없이 같은 형태의 데이터를 받는다.



### Redis로 API 호출 줄이기

실시간 버스 위치같이 계속 변하는 데이터는 매번 API를 호출해야 하지만, 
**노선 정보**나 **정류장 목록**처럼 자주 안 바뀌는 데이터는 캐싱해서 **공공 API 호출을 줄일 수 있다**.

노선 개요는 6시간 TTL, 정류장 목록은 24시간 TTL로 Redis에 캐싱했다. 
같은 노선을 여러 유저가 검색해도 공공 API는 한 번만 호출되고, 이후는 Redis에서 바로 꺼내주는 구조를 만들었다. 


## 💁 핵심 로직: 알림 타이머

버스벨에서 가장 고민을 많이 한 부분이다.

알림마다 독립적인 타이머를 돌리되, **ETA와 알림 조건의 차이에 따라 폴링 주기를 조절하는 방식**으로 바꿨다.

예를 들어 "5분 전 알림"을 설정했고 현재 버스 ETA가 20분이면:

- gap이 15분 → 10분 뒤에 다시 확인
- gap이 8분 → 5분 뒤에 다시 확인
- gap이 3분 → 1분 뒤에 다시 확인
- 조건 충족 → FCM 발송

쉽게 말해, gap이 클 때는 느슨하게, 가까워질수록 촘촘하게 체크한다. 
이렇게 하면 불필요한 API 호출이 확 줄어들고, 공공 API 호출 제한도 아낄 수 있다.


### 1) 알림 예약 흐름

![알림 예약 흐름](/images/posts/busbell-3/notification-reserve-flow.png)

유저가 알림을 예약하면 바로 저장하는 게 아니라, 먼저 현재 ETA를 검증한다. 
버스가 이미 3분 후 도착인데 "5분 전 알림"을 설정하면 의미가 없기 때문이다.

### 2) 타이머 폴링 → 푸시 발송

![타이머 폴링과 푸시 발송 흐름](/images/posts/busbell-3/polling-push-flow.png)

### 3) FCM 실패 시 재시도

![FCM 실패 재시도 흐름](/images/posts/busbell-3/fcm-retry-flow.png)

FCM 발송은 네트워크 문제나 토큰 만료 등으로 실패할 수 있다. 
그래서 최대 3회, 30초 간격으로 재시도하고, 3번 모두 실패하면 `Expired` 처리했다.


### 4) 서버 재시작 시 타이머 복원

Railway 같은 플랫폼은 서버가 언제든 재시작될 수 있다. 
(실제로 최대 요금 limit에 걸려 스스로 서버를 중지한 적이 있었다.)

이런 경우 메모리에만 타이머를 들고 있으면 재시작 순간 예약된 알림이 전부 날아간다.

그래서 애플리케이션이 부트스트랩되는 시점에 DB의 `Reserved` 상태 알림을 조회해 타이머를 복원하도록 했다.

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

물론 Redis와 메시지 큐를 사용하여 더 견고한 구조를 만들 수 있지만,
1인 사이드 프로젝트에서는 이 정도가 적절한 선이라고 판단한다. 

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

인증은 JWT access + refresh 토큰 구조로 구성했고, 로그인 시 FCM 토큰도 함께 저장했다. 

(같은 계정으로 여러 기기에서 알림을 받을 수 있다는 점을 고려했지만, 실제 내가 여러 기기로 알림을 받을 필요가 있을까라는 생각도 든다.)

## 💁 다음 글에서는

백엔드 API가 완성됐으니, 이제 이 API를 호출할 앱을 만들 차례다. 다음 글에서는 React Native로 버스 검색 → 노선 상세 → 알림 설정까지의 화면을 어떻게 구현했는지 정리할 예정이다.
