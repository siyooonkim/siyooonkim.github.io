---
title: '어텐션 모델 파헤치기'
description: ''
pubDate: '2025-12-20'
category: '딥러닝'
tags: []
draft: false
---

Transformer 논문("Attention Is All You Need")을 읽고 정리한 글이다. RNN 없이 Attention만으로 시퀀스를 처리할 수 있다는 게 핵심인데, 이게 GPT, BERT, ChatGPT까지 이어지는 시작점이다.

논문을 읽기만 하면 이해한 것 같다가도 코드로 옮기면 모르는 게 드러난다. 그래서 PyTorch 구현과 함께 정리했다.

---

## 왜 Attention인가

기존 시퀀스 모델(RNN, LSTM)은 단어를 순서대로 처리한다. "나는 어제 서울에서 맛있는 밥을 먹었다"라는 문장이 있으면, "나는"부터 시작해서 "먹었다"까지 순차적으로 읽는다.

문제가 두 가지다.

1. **병렬 처리가 안 된다.** 앞 단어를 처리해야 뒷 단어를 처리할 수 있으니까.
2. **긴 문장에서 앞부분을 잊어버린다.** 20번째 단어를 처리할 때 1번째 단어의 정보가 희미해진다.

Attention은 이 두 문제를 한 번에 해결한다. 모든 단어가 다른 모든 단어를 동시에 참조할 수 있다. 순서대로 읽을 필요가 없으니 병렬 처리가 되고, 거리에 상관없이 직접 참조하니 앞부분을 잊어버릴 일도 없다.

---

## Transformer 전체 구조

Transformer는 Encoder와 Decoder로 구성된다. 번역을 예로 들면, Encoder가 입력 문장(독일어)을 이해하고, Decoder가 출력 문장(영어)을 생성한다.

```
입력 (독일어)
    ↓
[ Encoder ] × N층
    ↓
인코딩된 표현 (z)
    ↓
[ Decoder ] × N층
    ↓
출력 (영어)
```

논문에서는 N=6, 즉 Encoder 6층, Decoder 6층을 쌓았다.

각 층의 내부는 이렇다.

```
Encoder 1층:
  ① Multi-Head Self-Attention
  ② Layer Normalization + Residual Connection
  ③ Position-wise Feed-Forward
  ④ Layer Normalization + Residual Connection

Decoder 1층:
  ① Masked Multi-Head Self-Attention
  ② Layer Norm + Residual
  ③ Multi-Head Encoder-Decoder Attention (Q는 Decoder, K/V는 Encoder)
  ④ Layer Norm + Residual
  ⑤ Position-wise Feed-Forward
  ⑥ Layer Norm + Residual
```

---

## Query, Key, Value

Attention의 핵심 개념이다.

도서관에서 책을 찾는 상황을 생각하면 된다.

- **Query**: 내가 찾고 싶은 것. "딥러닝 입문서 있나요?"
- **Key**: 각 책의 라벨. "이 책은 딥러닝", "이 책은 요리", "이 책은 수학"
- **Value**: 실제 책의 내용.

Query와 Key를 비교해서 관련도(점수)를 매기고, 그 점수에 따라 Value를 가중합한다. "딥러닝" 라벨이 붙은 책의 내용은 많이 반영하고, "요리" 라벨이 붙은 책은 거의 무시하는 식이다.

수식으로 쓰면:

```
Attention(Q, K, V) = softmax(QK^T / √dk) × V
```

`QK^T`가 Query와 Key의 유사도를 계산하는 부분이고, `√dk`로 나누는 건 값이 너무 커지면 softmax가 극단적으로 쏠리는 걸 방지하기 위해서다. softmax를 거치면 확률 분포가 되고, 이걸 Value에 곱해서 가중합을 구한다.

---

## Multi-Head Attention

Attention을 한 번만 하는 게 아니라, **여러 개의 "관점"으로 동시에** 수행한다. 이게 Multi-Head다.

논문에서는 8개의 Head를 사용했다. 임베딩 차원이 512이면, 각 Head는 512/8 = 64차원을 담당한다.

```python
class MultiHeadAttentionLayer(nn.Module):
    def __init__(self, hidden_dim, n_heads, dropout_ratio, device):
        super().__init__()

        self.hidden_dim = hidden_dim
        self.n_heads = n_heads
        self.head_dim = hidden_dim // n_heads

        self.fc_q = nn.Linear(hidden_dim, hidden_dim)
        self.fc_k = nn.Linear(hidden_dim, hidden_dim)
        self.fc_v = nn.Linear(hidden_dim, hidden_dim)
        self.fc_o = nn.Linear(hidden_dim, hidden_dim)

        self.scale = torch.sqrt(torch.FloatTensor([self.head_dim])).to(device)
```

왜 여러 Head로 나누는가? 같은 문장에서도 문법적 관계, 의미적 관계, 위치적 관계 등 다양한 관점이 있다. Head 하나가 한 가지 관점을 학습하도록 유도하는 것이다.

"나는 어제 서울에서 밥을 먹었다"에서:
- Head 1은 "나는"과 "먹었다"의 주어-서술어 관계를 학습
- Head 2는 "어제"와 "먹었다"의 시간-동작 관계를 학습
- Head 3은 "서울에서"와 "밥을"의 장소-목적어 관계를 학습

이런 식으로 서로 다른 관계를 병렬로 학습한다.

---

## Scaled Dot-Product Attention

Multi-Head 안에서 실제로 Attention이 계산되는 부분이다.

```python
def forward(self, query, key, value, mask=None):
    batch_size = query.shape[0]

    Q = self.fc_q(query)
    K = self.fc_k(key)
    V = self.fc_v(value)

    # hidden_dim → n_heads × head_dim으로 reshape
    Q = Q.view(batch_size, -1, self.n_heads, self.head_dim).permute(0, 2, 1, 3)
    K = K.view(batch_size, -1, self.n_heads, self.head_dim).permute(0, 2, 1, 3)
    V = V.view(batch_size, -1, self.n_heads, self.head_dim).permute(0, 2, 1, 3)

    # Q × K^T / √dk
    energy = torch.matmul(Q, K.permute(0, 1, 3, 2)) / self.scale

    # 마스크 적용 (패딩이나 미래 단어 차단)
    if mask is not None:
        energy = energy.masked_fill(mask == 0, -1e10)

    # softmax로 확률 분포 생성
    attention = torch.softmax(energy, dim=-1)

    # 확률 × Value = 가중합
    x = torch.matmul(self.dropout(attention), V)

    # Head들을 다시 합침 (Concat)
    x = x.permute(0, 2, 1, 3).contiguous()
    x = x.view(batch_size, -1, self.hidden_dim)

    return self.fc_o(x), attention
```

과정을 정리하면:

1. Q, K, V를 각각 Linear 레이어로 변환
2. n_heads개로 분할 (512차원 → 8개 × 64차원)
3. 각 Head에서 Q × K^T / √dk 계산
4. 마스크 적용 (패딩 토큰이나 미래 단어를 -∞로 만들어 softmax에서 0%에 가깝게)
5. softmax → 확률 분포
6. 확률 × V → 가중합
7. 모든 Head의 결과를 다시 합침 (Concat)
8. 최종 Linear 레이어로 출력

---

## 마스킹

마스크는 두 종류다.

**Source Mask (패딩 마스크)**

입력 문장의 길이가 다르면 짧은 문장에 `<pad>` 토큰을 채운다. 이 패딩은 의미가 없으니 Attention에서 무시해야 한다. 마스크 값을 0으로 설정하면 해당 위치의 energy가 -∞가 되고, softmax 후 확률이 0%에 가까워진다.

**Target Mask (미래 단어 마스크)**

Decoder에서 사용한다. "I ate rice"를 생성할 때, "I"를 생성하는 시점에서 "ate"나 "rice"를 미리 볼 수 없어야 한다. 현재 위치 이후의 단어를 전부 마스킹한다.

```python
# 하삼각 행렬로 미래 단어 차단
trg_sub_mask = torch.tril(torch.ones((trg_len, trg_len))).bool()
```

```
[[1, 0, 0],
 [1, 1, 0],
 [1, 1, 1]]
```

1번째 단어는 자기 자신만, 2번째 단어는 1~2번째만, 3번째 단어는 1~3번째를 볼 수 있다.

---

## Positional Encoding

Attention은 모든 단어를 동시에 보기 때문에, 순서 정보가 없다. "나는 밥을 먹었다"와 "밥을 나는 먹었다"가 같은 입력으로 처리된다.

이걸 해결하기 위해 단어 임베딩에 위치 정보를 더한다. 논문에서는 sin/cos 함수를 사용했지만, 실제 구현에서는 학습 가능한 위치 임베딩을 사용하는 경우가 많다.

```python
self.tok_embedding = nn.Embedding(input_dim, hidden_dim)   # 단어 임베딩
self.pos_embedding = nn.Embedding(max_length, hidden_dim)   # 위치 임베딩

# 순전파 시 둘을 더함
src = self.tok_embedding(src) * self.scale + self.pos_embedding(pos)
```

`* self.scale`은 임베딩 값에 √hidden_dim을 곱하는 건데, 위치 임베딩과 스케일을 맞추기 위해서다.

---

## Feed-Forward Layer

Attention 후에 오는 레이어다. 두 개의 Linear 사이에 ReLU를 끼운 구조. 각 단어 위치에 독립적으로 적용된다.

```python
class PositionwiseFeedforwardLayer(nn.Module):
    def __init__(self, hidden_dim, pf_dim, dropout_ratio):
        super().__init__()
        self.fc_1 = nn.Linear(hidden_dim, pf_dim)    # 512 → 2048
        self.fc_2 = nn.Linear(pf_dim, hidden_dim)    # 2048 → 512

    def forward(self, x):
        x = self.dropout(torch.relu(self.fc_1(x)))
        return self.fc_2(x)
```

입력과 출력 차원은 512로 동일하고, 내부 차원은 2048로 확장했다가 다시 줄인다. 비선형성을 추가하는 역할이다.

---

## Residual Connection + Layer Normalization

각 서브레이어(Attention, Feed-Forward)마다 입력을 출력에 더하고(Residual Connection), 정규화한다(Layer Norm).

```python
# Attention → Dropout → 입력과 더하기 → Layer Norm
_src, _ = self.self_attention(src, src, src, src_mask)
src = self.self_attn_layer_norm(src + self.dropout(_src))
```

Residual Connection은 "최소한 입력 정보는 보존한다"는 안전장치다. 레이어를 깊게 쌓아도 학습이 안정적이다.

---

## Encoder와 Decoder의 차이

Encoder의 Self-Attention은 입력 문장 내에서 모든 단어가 서로를 참조한다. Q, K, V 전부 같은 입력에서 나온다.

Decoder는 두 종류의 Attention을 사용한다.

1. **Masked Self-Attention**: 출력 문장 내에서 자기 자신을 참조. 단, 미래 단어는 마스킹.
2. **Encoder-Decoder Attention**: Q는 Decoder에서, K와 V는 Encoder의 출력에서 가져온다. 이렇게 해야 "입력 문장의 어떤 부분을 참조해서 다음 단어를 생성할지" 결정할 수 있다.

```python
# Decoder의 Encoder-Decoder Attention
# Q는 디코더의 현재 상태, K/V는 인코더의 출력
_trg, attention = self.encoder_attention(trg, enc_src, enc_src, src_mask)
```

---

## 정리

Transformer의 핵심을 한 줄로 요약하면:

> **모든 단어가 다른 모든 단어를 동시에 참조하되, 여러 관점(Head)에서 병렬로 수행한다.**

RNN이 순차적으로 읽으면서 앞 정보를 잊어버리는 문제를 Attention으로 해결했고, 이게 현재 GPT, BERT, ChatGPT 등 거의 모든 대형 언어 모델의 기반 구조가 됐다.

논문 제목이 "Attention Is All You Need"인 이유가 있다. 진짜로 Attention만으로 충분했다.