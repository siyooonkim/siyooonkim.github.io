---
title: '답답해서 만든 버스 알림 앱 (2)'
description: ''
pubDate: '2025-09-06'
updatedDate: '2025-09-06'
category: '사이드 프로젝트'
tags: ['project', 'busbell', 'backend', 'nestjs', 'fcm', 'adapter-pattern']
draft: false
---

이제 버스벨의 백엔드 구현을 시작한다.<br>

## 💁 백엔드 구조 나누기

> 공공 API에서 버스 위치를 가져오고, 유저가 설정한 조건에 맞으면 푸시 알림을 쏜다.

위 역할을 기준으로 크게 네 가지로 나눴다.<br>

1. **버스 정보 조회** — 공공데이터 API에서 노선, 정류장, 실시간 위치, ETA를 가져온다<br>
2. **알림 예약/관리** — 유저가 설정한 알림을 DB에 저장하고 상태를 관리한다<br>
3. **타이머** — 버스 도착 시간을 추적하다가, 조건이 충족되면 푸시를 발송한다<br>
4. **인증** — 회원가입, 로그인, JWT 토큰, FCM 토큰 관리<br>

이 네 가지를 NestJS 모듈 단위로 나눠서 하나씩 만들어가기로 했다.<br>

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


문제는 이 두 API가 완전히 다른 서비스라는 점이었다.<br>
URL도 다르고, 응답 필드명도 다르고, 에러 코드도 다르다.<br>
처음에는 `if` 문으로 분기 처리를 할까 했다가,<br>
코드가 금방 지져분해지는 경험을 토대로,, 어댑터 패턴으로 분리했다.<br>

```text
BusApiService (파사드)
  ├── SeoulAdapter    → 서울 TOPIS API 호출
  └── GyeonggiAdapter → 경기 GBIS API 호출
```

### 핵심은 **추상화**다.
서울 API와 경기도 API는 형태가 많이 다르다. <br>
서울은 JSON을 사용하지만, 경기도는 XML을 사용하고   
필드명도 `busRouteId`와 `routeId`처럼 서로 다르다.  
도착 시간 역시 서울은 초 단위, 경기도는 분 단위로 제공된다. <br>

이런 차이를 호출하는 쪽에서 모두 처리하게 하면 코드가 복잡해진다.  <br>
그래서 이 차이를 내부에서 흡수하도록 설계했다. <br>

`BusSearchResult`, `ArrivalInfo`, `LiveData` 같은 공통 인터페이스를 먼저 정의하고,  <br>
각 어댑터가 지역별 API 응답을 이 형태로 변환하도록 구성했다. <br>

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
핵심은 **호출하는 쪽에서는 이런 차이를 알 필요가 없도록 만드는 것**이다. <br>

경기도 어댑터는 `predictTime1`을 그대로 넣고, 서울 어댑터는 초 단위 응답을 60으로 나눠 넣는다.<br>
`BusApiService`는 `cityCode`만 보고 어떤 어댑터를 쓸지 결정한다.<br>
결과적으로 앱은 서울/경기를 구분할 필요 없이 같은 형태의 데이터를 받는다.<br>



### Redis로 API 호출 줄이기

실시간 버스 위치같이 계속 변하는 데이터는 매번 API를 호출해야 하지만,<br>
**노선 정보**나 **정류장 목록**처럼 자주 안 바뀌는 데이터는 캐싱해서 **공공 API 호출을 줄일 수 있다**.<br>

노선 개요는 6시간 TTL, 정류장 목록은 24시간 TTL로 Redis에 캐싱했다.<br>
같은 노선을 여러 유저가 검색해도 공공 API는 한 번만 호출되고, 이후는 Redis에서 바로 꺼내주는 구조를 만들었다.<br> 


## 💁 핵심 로직: 알림 타이머

버스벨에서 가장 고민을 많이 한 부분이다.<br>

알림마다 독립적인 타이머를 돌리되, **ETA와 알림 조건의 차이에 따라 폴링 주기를 조절하는 방식**으로 바꿨다.<br>

예를 들어 "5분 전 알림"을 설정했고 현재 버스 ETA가 20분이면:

- gap이 15분 → 10분 뒤에 다시 확인
- gap이 8분 → 5분 뒤에 다시 확인
- gap이 3분 → 1분 뒤에 다시 확인
- 조건 충족 → FCM 발송

쉽게 말해, gap이 클 때는 느슨하게, 가까워질수록 촘촘하게 체크한다.<br>
이렇게 하면 불필요한 API 호출이 확 줄어들고, 공공 API 호출 제한도 아낄 수 있다.<br>


### 1) 알림 예약 흐름

![알림 예약 흐름](/images/posts/busbell-3/notification-reserve-flow.png)

알림은 가장 가까운 버스를 기준으로 발송한다. <br>
따라서 유저가 알림을 예약하면, 먼저 현재 ETA를 검증한다. <br>
예를 들어 가장 가까운 버스가 3분 후 도착인데 “5분 전 알림”을 설정하면 의미가 없기 때문이다. <br>

### 2) 타이머 폴링 → 푸시 발송

![타이머 폴링과 푸시 발송 흐름](/images/posts/busbell-3/polling-push-flow.png)

### 3) FCM 실패 시 재시도

![FCM 실패 재시도 흐름](/images/posts/busbell-3/fcm-retry-flow.png)

FCM 발송은 네트워크 문제나 토큰 만료 등으로 실패할 수 있다.  <br>
일시적인 오류로 인한 실패를 고려해, 30초 간격으로 최대 3회까지 재시도하도록 처리했다. <br>


### 4) 서버 재시작 시 타이머 복원
Railway 같은 플랫폼은 서버가 언제든 재시작될 수 있다.<br>
실제로 요금 제한에 걸려 서버가 중지된 경험이 있었다)<br>

이런 경우 메모리에만 타이머를 들고 있으면 재시작 순간 예약된 알림이 전부 날아간다.<br>

이를 방지하기 위해 애플리케이션 부트스트랩 시점에 DB에 저장된 `Reserved` 상태의 알림을 조회하고, 타이머를 다시 등록하도록 했다.<br>

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

물론 Redis와 메시지 큐를 사용하여 더 견고한 구조를 만들 수 있지만,<br>
1인 사이드 프로젝트에서는 이 정도가 적절한 선이라고 판단한다.<br> 

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

인증은 JWT access + refresh 토큰 구조로 구성했고, 로그인 시 FCM 토큰도 함께 저장했다.<br>

여러 기기에서 알림을 받을 수 있는 구조를 고려했지만, 실제 사용에서는 한 기기만 사용하는 경우가 대부분일 것 같다는 생각도 든다. <br>

## 💁 다음 글에서는

다음 글에서는 React Native로 버스 검색 → 노선 상세 → 알림 설정까지의 화면을 어떻게 구현했는지를 다룬다. <br>
