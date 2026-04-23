---
title: '답답해서 만든 버스 알림 앱 (3)'
description: ''
pubDate: '2025-09-06'
category: '사이드 프로젝트'
tags: ['project', 'busbell']
draft: false
---

구현해야할 화면도 많지 않기 때문에 앱 개발은 생각보다 빠르게 진행됐다.<br>

## Tailwind 를 걷어낸 이유 
과거 Next.js에서 Tailwind를 사용할 때 생산성이 좋았던 경험이 있어, React Native에서도 동일하게 적용해봤다.<br>

근데 막상 써보니 문제가 있었다.<br>

웹에서는 브라우저 DevTools로 요소를 클릭하면 어떤 Tailwind 클래스가 적용됐는지 바로 보이는데,<br>
RN에서는 이를 확인할 수 있는 도구가 없다.<br>
`className="flex-1 px-4 mt-2"` 같은 게 실제로 어떤 스타일로 변환됐는지 확인하려면 로그를 찍거나 하나씩 빼봐야 했다.<br>

결국 Tailwind를 통째로 걷어내고 다시 StyleSheet을 사용했다.<br> 

## 화면 구성
화면은 총 4가지로 구성했다.<br> 

```
Onboarding → Search → RouteDetail → AlarmList
```

| 화면 | 하는 일 |
|------|--------|
| Search | 버스 번호 입력 → 노선 선택 |
| RouteDetail | 정류장 목록 보고 → 알림 설정 |
| AlarmList | 내 알림 확인/취소 |
| Onboarding | 첫 진입 시 서비스 소개 |

실제 사용자 흐름은 단순하다.<br>
검색 → 노선 선택 → 알림 설정, 이 3단계면 충분하다.<br>

화면을 그리다 보니 더 추가하고 싶은 것들이 많았지만,<br>
과거 사이드 프로젝트를 진행하다 기능 확장에 지쳐 중단했던 경험이 있어, 이번에는 처음부터 MVP 범위에 집중했다.<br>

실제 화면은 아래와 같다.<br>

### 검색 화면

<img src="/images/posts/busbell-4/search.png" alt="검색 화면" style="max-width: 220px;" />

메인 화면이다. 버스 번호를 입력하면 바로 검색할 수 있다.  <br>
자주 찾는 버스를 빠르게 접근할 수 있도록 최근 검색한 버스 번호를 카드 형태로 보여준다.  <br>

(9507, 3213, 9401, M4403 — 전부 내가 실제로 자주 이용하는 노선들이다.)<br>

### 검색 결과

<img src="/images/posts/busbell-4/search-result.png" alt="검색 결과" style="max-width: 220px;" />

버스 번호를 입력하면 해당 노선 정보가 바로 나타난다.  <br>  
기점/종점, 지역, 버스 유형 등을 확인할 수 있다.  <br>

여기서 원하는 노선을 선택하면 다음 단계로 이동한다. <br>

### 노선 상세 + 알림 설정

<img src="/images/posts/busbell-4/route-detail.png" alt="노선 상세" style="max-width: 220px;" />

노선을 선택하면 정류장 목록이 나오고, 정류장을 탭하면 바텀시트 형태로 알림 설정 화면이 올라온다.  

현재 ETA를 함께 보여주며 “도착 몇 분 전에 알려드릴까요?”를 기준으로 알림을 설정할 수 있다.  
프리셋과 직접 입력을 모두 지원한다.  

ETA보다 큰 값을 입력하면 “도착 예정 시간(3분)보다 큽니다”와 같은 경고 토스트를 띄워 잘못된 설정을 방지했다.

### 알림 내역

<img src="/images/posts/busbell-4/alarm-list.png" alt="알림 내역" style="max-width: 220px;" />

설정한 알림 목록을 확인하는 화면이다.<br>

버스 번호, 정류장, 도착 예정 시간, 알림 시점 등을 확인할 수 있고, 필요 시 알림을 취소할 수 있다.<br>

다만 실제로 사용해보니 별도의 화면으로 분리할 필요성은 크지 않다고 느꼈다.<br>
홈 화면에서 함께 보여주는 방식으로도 충분히 커버할 수 있을 것 같다는 생각이 들었다.<br>

## API 레이어 (관심사 분리)

별거 아닌 것처럼 보이지만, API 호출 로직을 어디에 두느냐에 따라 코드 수정 범위와 유지보수 난이도가 크게 달라진다. <br>

```ts
// 관심사 분리 전 
function SearchScreen() {
  const search = async () => {
    const res = await fetch('/api/bus/search?keyword=9507');
    const data = await res.json();
    // 화면에 바로 사용
  };
}


// 관심사 분리 후 
export const searchBus = (keyword: string) => {
  return fetch(`/api/bus/search?keyword=${keyword}`);
};

```
이것도 일종의 추상화인데, <br>
핵심 API 호출 로직을 별도의 함수로 분리해 내부 구현을 감추고, 화면에서는 해당 함수를 호출하는 방식으로 사용했다.  <br>

이렇게 하면 API 변경이 발생하더라도 한 곳만 수정하면 되고,  <br>
여러 호출부에서 동일한 로직을 재사용할 수 있어 유지보수가 수월해진다. <br>

## 푸시 알림
전체 푸시 흐름은 다음과 같다.<br>

1. 앱 시작 → Firebase에서 FCM 토큰 발급<br>
2. 로그인 시 해당 토큰을 백엔드 `User` 테이블에 저장<br>
3. 백엔드에서 ETA 조건 충족 → FCM으로 푸시 발송<br>
4. 앱에서 수신<br>

푸시알림 테스트를 진행하며 알게된 내용인데, 개발용과 프로덕션용 APNs가 따로 존재한다는 점이다.<br>
(APNs는 서버에서 보낸 푸시 알림을 실제 기기로 전달해주는 애플의 시스템이라고 보면 된다.)<br>

처음에는 하나의 APNs를 Firebase에 설정해두면, 환경에 따라 알아서 처리해주는 구조인 줄 알았는데,<br>
(즉, 푸시 환경을 제어하는 주체가 Firebase라고 생각했던 것이다.)<br>

실제로는 iOS에서<br>
- 개발 환경은 sandbox APNs<br>
- 프로덕션 환경은 production APNs<br>

를 각각 사용하고, 이 구분은 Firebase가 아니라 Apple 쪽에서 이미 나뉘어 있는 구조였다.<br>

이유는 앱의 빌드 타입(Debug/Release)에 따라 다른 APNs 서버와 토큰을 사용하기 때문이다.<br>

## 전체 플로우

![전체 플로우 시퀀스 다이어그램](/images/posts/busbell-4/sequence-diagram.png)

## 마치며

공공 API 연동, 실시간 폴링, FCM 푸시 파이프라인, React Native 빌드, 앱스토어 출시까지 한 사이클을 전부 끝낼 수 있었다.<br>

아직 고쳐야 할 부분도 많고, UI/UX 개선 그리고 즐겨찾기 기능, 지도 기능, 지하철 지원 등 추가하고 싶은 기능도 많다.<br>

예상치 못한 부분에서 병목이 생겼고, 그런 상황들이 날 계속 지치게 만들었다.<br>

이 과정에서 깨달은 건 꼭 완벽할 필요 없다는 점이다.<br> 

![완벽주의](/images/posts/busbell-4/perfectionism.png)

'그냥 넘어가자'라는 유혹과 어느 정도 타협하면서 앞으로 나아가는 것도 분명 중요한 부분이다.<br>
모든 사이클을 한번 돌아보는 것, 완벽하다고 생각할때까지 하나만 파는 것보다 낫다.<br>
이걸 받아들이지 못하면, 즐거운 마음으로 시작한 프로젝트가 스트레스로 이어지기 때문이다.<br> 



> 시리즈
> - [답답해서 만든 버스 알림 앱 (1)](/posts/2025/09/06/busbell-dev-log-1)
> - [답답해서 만든 버스 알림 앱 (2)](/posts/2025/09/06/busbell-dev-log-2)
> - **답답해서 만든 버스 알림 앱 (3)** ← 현재 글
