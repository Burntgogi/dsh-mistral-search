# dsh-mistral-search

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)의 `web_search`를 Mistral 내장 웹 검색 도구로 제공합니다. Mistral 키를 쓰며, DeepSeek 키와 Vibe 프로그램은 필요 없습니다.

DeepSeek이나 Mistral의 공식 프로젝트가 아닌 커뮤니티 플러그인입니다. Mistral 웹 검색은 무료가 아닙니다. [비용](#비용)을 확인하세요.

[English](README.md)

## 요구 사항

- DeepSeek Harness 0.2.2-rc.1. 버전을 고정했으므로 새 Harness 버전에는 새 플러그인 릴리스가 필요합니다.
- `MISTRAL_VIBE_API_KEY`라는 이름의 Mistral 키. 다른 이름을 쓰려면 `apiKeyEnv`로 지정합니다. Harness 자격 증명 저장소에 넣거나, 실행 전에 환경 변수로 설정하세요. 실제 검색은 Vibe 키로만 시험했습니다.

## 설치

```bash
dsh plugin --profile web add github:Burntgogi/dsh-mistral-search#v0.1.0
```

설치판은 `--profile desktop`을 쓰세요. 설치 후 Harness를 다시 시작합니다.

키가 저장되어 있지 않으면 항상 실패할 도구를 내놓는 대신 Harness가 모델에게서 `web_search`를 숨깁니다.

## 동작 방식

```text
web_search → dsh-mistral-search → POST {baseURL}/conversations (tools: web_search) → 출처 목록
```

Mistral 문서에는 모델 없이 검색만 하는 엔드포인트가 없어서, 검색어마다 한 턴짜리 대화를 보냅니다. 세션 모델과 관계없이 기본값인 `mistral-small-latest`가 검색을 실행하고, 플러그인이 결과를 Harness에 돌려줍니다. `store: false`로 Mistral에 대화를 보관하지 말라고 요청합니다.

검색어는 Mistral로 전송됩니다. 2026년 11월에 측정한 응답은 결과에 `source: brave`를 표시했습니다. Mistral이 검색어를 Brave Search로 넘기는 것으로 보이지만, Mistral 문서에는 나와 있지 않습니다.

## 설정

프로필의 `cordis.patch.yml`에 적습니다. 모두 선택 사항입니다.

```yaml
- id: dsh-mistral-search
  name: dsh-mistral-search
  config:
    model: mistral-small-latest
    apiKeyEnv: MISTRAL_VIBE_API_KEY
    baseURL: https://api.mistral.ai/v1
```

| 설정 | 의미 |
|---|---|
| `model` | 검색을 실행할 모델. 내장 커넥터를 받는 모델이어야 합니다. |
| `apiKeyEnv` | 키가 저장된 자격 증명 이름. 키 자체를 적지 않습니다. |
| `baseURL` | Mistral API 주소. |

### 동작하는 모델

2026년 11월에 Vibe 키로 측정한 결과입니다. Mistral 모델 카드와 다를 수 있습니다.

| 모델 | 결과 |
|---|---|
| `mistral-small-latest` | 동작 |
| `deepseek-v4-1-flash-1017` | 거부: HTTP 400, code 3004. 카드에는 내장 도구가 표시되어 있음 |
| `ministral-3b-latest`, `ministral-14b-latest` | 거부: HTTP 400, code 3004 |

## 비용

Mistral 웹 검색은 무료가 아닙니다. Mistral 문서에 따르면 API 키는 플랜에 묶이지 않고, 모든 키가 조직의 Mistral 플랜과 종량 과금 설정을 따릅니다. 월간 포함 사용량은 Studio, API, Vibe Code가 함께 쓰며 먼저 차감됩니다. 그 뒤로는 종량 과금이 켜져 있으면 선불 크레딧에서 차감되고, 꺼져 있으면 다음 결제 주기까지 사용이 멈출 수 있습니다. [API 키](https://docs.mistral.ai/admin/identity-access/api-keys)와 [구독](https://docs.mistral.ai/admin/billing-usage/subscriptions) 문서를 참고하세요. 플러그인은 이 설정을 읽을 수 없으니 직접 확인하세요.

2026년 11월의 적은 표본에서 검색어 하나는 보통 입력 약 800토큰, 검색 결과 5,000~8,500토큰, 출력 20~70토큰을 썼습니다. 긴 검색어 하나는 모델이 하지 말라는 설명을 쓰면서 출력이 522토큰이었습니다. 재시도하면 요청이 한 번 더 나갑니다. Mistral은 토큰을 플랜 사용량으로 바꾸는 환산을 공개하지 않으며, 이 플러그인이 플랜을 얼마나 쓰는지는 따로 재지 못했습니다.

`web_search` 한 번에 검색어를 최대 4개 보낼 수 있고, 검색어마다 따로 계산됩니다.

## 동작 규칙

- 사용량 제한, 서버 오류, 네트워크 실패, 모델이 도구를 건너뛴 경우 한 번 재시도합니다. 5초 넘게 기다려야 하면 재시도하지 않습니다.
- 시도당 제한 시간은 20초이고, 취소하면 바로 멈춥니다.
- 키가 거부되거나 요청이 잘못되면 Mistral이 알려 준 이유와 함께 바로 실패합니다.
- Mistral이 `prompt injection pattern detected`를 이유로 검색의 도구 응답이 차단됐다고 알릴 수 있습니다. 플러그인은 모델에게 웹에 결과가 없는 것이 아니라 검색이 차단됐다고 알리고, 같은 호출의 다른 검색어는 계속 실행됩니다. [제한](#제한)을 참고하세요.
- Mistral 모델이 요청과 다른 검색어로 검색하면 결과는 유지하고, 어떤 검색어를 썼는지 모델에게 알립니다. 측정한 표본에서는 검색어가 항상 일치했습니다.
- 빈 결과는 "결과 없음"으로 처리합니다. 플러그인이 해석하지 못한 응답은 오류로 처리해서, Mistral의 형식 변경을 빈 검색으로 오인하지 않습니다.
- 원본 결과는 Mistral 문서에 없는 `info.result` 필드에서 읽습니다. 이 필드가 사라지면 인용 정보를 대신 쓰고, 그것도 없으면 위 오류를 냅니다.

## 제한

- 플러그인은 자신을 `searchProvider`로 고정합니다. 끄기만 하고 고정을 남기면 검색이 `WEB_PROVIDER_CONFIGURED_MISSING`으로 실패합니다. 플러그인을 제거하면 플러그인이 추가한 고정은 사라집니다. 직접 저장한 `searchProvider`는 남으므로 직접 지워야 합니다.
- Harness 웹 검색 설정 스위치는 `searchProvider`를 덮어씁니다. 스위치를 썼다면 `dsh-mistral-search`로 되돌리세요.
- 엔진이 하나뿐이고 자동 대체가 없습니다.
- Mistral의 차단은 정상적인 주제에도 걸립니다. 2026년 11월 시험에서 `prompt injection attack examples`, `OWASP LLM01 prompt injection mitigation`, `ignore previous instructions meme origin`이 모두 차단됐습니다. 이 주제의 조사에는 맞지 않습니다. `DAN jailbreak prompt ChatGPT`를 포함한 다른 시험 검색은 통과했습니다. Mistral은 차단 기준을 밝히지 않으며, 다른 검색이 얼마나 자주 막히는지는 재지 않았습니다.

## 제거

```bash
dsh plugin --profile web remove dsh-mistral-search
```

## 개발

```bash
npm test
```

시험은 설치 없이 오프라인으로 돕니다. 로직은 `lib/search.js`에, Harness 연결은 `lib/index.js`에 있습니다.

## 라이선스

[MIT](LICENSE)
