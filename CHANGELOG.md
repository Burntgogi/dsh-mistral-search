# Changelog

## 0.1.1 (unreleased)

- Checks every search execution failure so an earlier failure cannot hide a later safety-filter block
- Keeps successful results with an incomplete-results warning when another search execution fails
- Limits each attempt to 12 seconds, keeping two attempts and the longest retry wait within the Harness's default 30-second tool budget

## 0.1.0

First public version, for DeepSeek Harness 0.2.2-rc.1.

- `web_search` through Mistral's built-in web search tool
- Hides `web_search` when no key is stored
- Works without the credentials service, reading the launch environment instead
- One retry on rate limits, server errors, network failures and skipped tool calls
- Treats an unreadable response as an error rather than an empty result
- Reports a search blocked by Mistral's safety filter instead of "no results"
- Tells the model when Mistral searched with different terms
