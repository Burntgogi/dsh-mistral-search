# dsh-mistral-search

Gives [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) `web_search` through Mistral's built-in web search tool, using your Mistral key. No DeepSeek key and no Vibe program are needed.

This is a community plugin, not an official DeepSeek or Mistral project. Mistral's web search is not free: see [Cost](#cost).

[한국어](README.ko.md)

## Requirements

- DeepSeek Harness 0.2.2-rc.1. The version is pinned, so a new Harness version needs a new plugin release.
- A Mistral key available as `MISTRAL_VIBE_API_KEY`, or under another name set through `apiKeyEnv`. Store it in the Harness credential store or set it as an environment variable before launch. Real searches were tested with a Vibe key only.

## Install

```bash
dsh plugin --profile web add github:Burntgogi/dsh-mistral-search#v0.1.0
```

Use `--profile desktop` for the desktop app. Restart the Harness afterwards.

If no key is stored, the Harness hides `web_search` from the model rather than offering a tool that always fails.

## How it works

```text
web_search → dsh-mistral-search → POST {baseURL}/conversations (tools: web_search) → sources
```

Mistral has no documented search endpoint without a model, so each query is a one-turn conversation. The default `mistral-small-latest` runs the search whatever model your session uses, and the plugin returns the results to the Harness. `store: false` asks Mistral not to keep the conversation.

Your search terms go to Mistral. Responses measured in November 2026 label their results with `source: brave`, which suggests Mistral passes queries on to Brave Search. Mistral does not document this.

## Settings

Set these in your profile's `cordis.patch.yml`. All are optional.

```yaml
- id: dsh-mistral-search
  name: dsh-mistral-search
  config:
    model: mistral-small-latest
    apiKeyEnv: MISTRAL_VIBE_API_KEY
    baseURL: https://api.mistral.ai/v1
```

| Setting | Meaning |
|---|---|
| `model` | The model that runs the search. It must accept built-in connectors. |
| `apiKeyEnv` | The credential name that holds the key. Never the key itself. |
| `baseURL` | The Mistral API address. |

### Which models work

Measured in November 2026 with a Vibe key. Mistral's model cards do not always match.

| Model | Result |
|---|---|
| `mistral-small-latest` | Works |
| `deepseek-v4-1-flash-1017` | Refused: HTTP 400, code 3004, although its card lists built-in tools |
| `ministral-3b-latest`, `ministral-14b-latest` | Refused: HTTP 400, code 3004 |

## Cost

Mistral's web search is not free. Mistral states that API keys are not scoped to plans: every key uses your organization's Mistral plan and pay-as-you-go settings. Included monthly usage is shared across Studio, the API and Vibe Code and is used first. After that, usage draws on prepaid credits if pay-as-you-go is on, and can stop until the next billing period if it is off. See [API keys](https://docs.mistral.ai/admin/identity-access/api-keys) and [Subscriptions](https://docs.mistral.ai/admin/billing-usage/subscriptions). The plugin cannot read these settings, so check them yourself.

In a small sample from November 2026, a query usually took about 800 input tokens, 5,000 to 8,500 search result tokens and 20 to 70 output tokens. One long query took 522 output tokens because the model wrote prose it was told not to write. A retry sends a second request. Mistral publishes no conversion from tokens to plan usage, and this plugin's share of plan usage has not been measured in isolation.

One `web_search` call can hold up to 4 queries, and each query counts separately.

## Behavior

- A rate limit, server error, network failure, or a turn where the model skipped the tool is retried once. A wait longer than 5 seconds is not retried.
- Each attempt is limited to 20 seconds. Cancelling stops immediately.
- A rejected key or a bad request fails at once with Mistral's reason.
- Mistral can report that a search's tool response was blocked, with the reason `prompt injection pattern detected`. The plugin tells the model the search was blocked, not that the web has no results, and other queries in the same call still run. See [Limits](#limits).
- If Mistral's model searched with different terms than the ones requested, the results are kept and the model is told which terms were used. In the sample measured, the terms always matched.
- An empty result reads as "no results". A response the plugin cannot understand reads as an error, so a format change at Mistral is not mistaken for an empty search.
- The raw results come from `info.result`, a field Mistral does not document. If it goes away, the plugin falls back to citation chunks, and otherwise reports the error above.

## Limits

- The plugin pins itself as `searchProvider`. If you disable it but keep the pin, searches fail with `WEB_PROVIDER_CONFIGURED_MISSING`. Removing the plugin removes the pin it added. A `searchProvider` you saved yourself stays and must be cleared by hand.
- The Harness web search settings switch overwrites `searchProvider`. Set it back to `dsh-mistral-search` if you use the switch.
- This plugin has only one engine and no automatic fallback.
- Mistral's block also hits legitimate topics. In November 2026, `prompt injection attack examples`, `OWASP LLM01 prompt injection mitigation` and `ignore previous instructions meme origin` were all blocked, so this plugin is a poor fit for research on that subject. Other test searches went through, including `DAN jailbreak prompt ChatGPT`. Mistral does not say what triggers the block, and how often other searches are blocked was not measured.

## Remove

```bash
dsh plugin --profile web remove dsh-mistral-search
```

## Development

```bash
npm test
```

The tests run offline and need no install. `lib/search.js` holds the logic, and `lib/index.js` connects it to the Harness.

## License

[MIT](LICENSE)
