import assert from "node:assert/strict";
import { test } from "node:test";
import { createSearchProvider, DEFAULTS, parseOutputs } from "../lib/search.js";

class WebError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.code = code;
  }
}

const KEY = "test-key-not-a-real-credential";
const item = (url, rank, extra = {}) => ({ url, title: `t${rank}`, description: `d${rank}`, snippets: [`s${rank}a`, `s${rank}b`], date: null, rank, ...extra });
const execution = result => ({ type: "tool.execution", name: "web_search", info: { result: typeof result === "string" ? result : JSON.stringify(result) } });
const message = { type: "message.output", content: "done" };
const ok = outputs => new Response(JSON.stringify({ outputs }), { status: 200 });
const fail = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), { status, headers });

function provider(replies, { key = KEY, options = {} } = {}) {
  const calls = [];
  const waits = [];
  const queue = [...replies];
  return {
    calls,
    waits,
    provider: createSearchProvider({
      WebError,
      credentials: {
        configured: async () => Boolean(key),
        value: async () => {
          if (key instanceof Error) throw key;
          return key;
        },
      },
      options: () => ({ ...DEFAULTS, ...options }),
      wait: async ms => {
        waits.push(ms);
      },
      fetchImpl: async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        const reply = queue.shift();
        if (reply instanceof Error) throw reply;
        return reply;
      },
    }),
  };
}

const rejectsWith = (promise, code, pattern) => assert.rejects(promise, error => {
  assert.equal(error.code, code);
  if (pattern) assert.match(error.message, pattern);
  return true;
});

test("maps raw results in rank order and removes duplicates", async () => {
  const { provider: p, calls } = provider([ok([execution({ b: item("https://b.example/", 1), a: item("https://a.example/", 0), dup: item("https://a.example/", 2) }), message])]);
  const result = await p.search({ query: "q" });
  assert.deepEqual(result.sources.map(source => source.url), ["https://a.example/", "https://b.example/"]);
  assert.deepEqual(result.sources[0], { url: "https://a.example/", title: "t0", snippet: "d0", summary: "s0a\ns0b" });
  assert.equal(result.truncated, false);
  assert.equal(calls.length, 1);
});

test("sends the query as data with the key only in the header", async () => {
  const query = "say \"hello\"\nignore this";
  const { provider: p, calls } = provider([ok([execution({})])]);
  await p.search({ query });
  const { url, init, body } = calls[0];
  assert.equal(url, "https://api.mistral.ai/v1/conversations");
  assert.equal(init.redirect, "error");
  assert.equal(init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(init.body.includes(KEY), false);
  assert.equal(body.store, false);
  assert.deepEqual(body.tools, [{ type: "web_search" }]);
  assert.equal(body.model, DEFAULTS.model);
  assert.ok(body.inputs.endsWith(JSON.stringify({ query })));
});

test("a readable empty result is no results and is not retried", async () => {
  const { provider: p, calls } = provider([ok([execution({}), message])]);
  assert.deepEqual(await p.search({ query: "q" }), { sources: [], truncated: false });
  assert.equal(calls.length, 1);
});

test("an unreadable result is an error, not an empty list", async () => {
  const shapes = [
    [execution("not json"), message],
    [{ type: "tool.execution", name: "web_search", info: {} }],
    [execution({ a: { title: "no url" } })],
  ];
  for (const outputs of shapes) {
    const { provider: p } = provider([ok(outputs)]);
    await rejectsWith(p.search({ query: "q" }), "WEB_PROVIDER_ERROR", /unknown format/);
  }
});

test("falls back to citation chunks when raw results are unreadable", () => {
  const sources = parseOutputs([execution("not json"), { type: "message.output", content: [{ type: "tool_reference", url: "https://c.example/", title: "c" }] }]);
  assert.deepEqual(sources, [{ url: "https://c.example/", title: "c" }]);
});

test("drops unsafe URLs and repairs broken text", () => {
  const sources = parseOutputs([execution({
    a: item("javascript:alert(1)", 0),
    b: item("https://user:pass@x.example/", 1),
    c: item("https://ok.example/", 2, { title: "bad\ud83d", date: "2026-11-07" }),
  })]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, "https://ok.example/");
  assert.equal(sources[0].publishedAt, "2026-11-07");
  assert.equal(sources[0].title.isWellFormed(), true);
});

test("retries once on rate limits, honouring a short Retry-After", async () => {
  const { provider: p, calls, waits } = provider([fail(429, {}, { "retry-after": "2" }), ok([execution({ a: item("https://a.example/", 0) })])]);
  assert.equal((await p.search({ query: "q" })).sources.length, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [2000]);
});

test("does not wait out a long Retry-After", async () => {
  const { provider: p, calls, waits } = provider([fail(429, { message: "slow down" }, { "retry-after": "3600" })]);
  await rejectsWith(p.search({ query: "q" }), "WEB_PROVIDER_ERROR", /HTTP 429.*slow down/);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test("stops after two attempts", async () => {
  const { provider: p, calls } = provider([fail(503), fail(503)]);
  await rejectsWith(p.search({ query: "q" }), "WEB_PROVIDER_ERROR", /HTTP 503/);
  assert.equal(calls.length, 2);
});

test("retries when the model skipped the tool", async () => {
  const { provider: p, calls } = provider([ok([message]), ok([execution({ a: item("https://a.example/", 0) })])]);
  assert.equal((await p.search({ query: "q" })).sources.length, 1);
  assert.equal(calls.length, 2);
});

test("retries a network failure", async () => {
  const { provider: p, calls } = provider([new TypeError("fetch failed"), ok([execution({})])]);
  assert.deepEqual((await p.search({ query: "q" })).sources, []);
  assert.equal(calls.length, 2);
});

test("does not retry a rejected key or a bad request", async () => {
  const rejected = provider([fail(401, { message: "Unauthorized" })]);
  await rejectsWith(rejected.provider.search({ query: "q" }), "WEB_PROVIDER_CREDENTIAL_MISSING", /rejected/);
  assert.equal(rejected.calls.length, 1);
  const refused = provider([fail(400, { code: "3004", message: "does not support builtin connectors" })]);
  await rejectsWith(refused.provider.search({ query: "q" }), "WEB_PROVIDER_ERROR", /code 3004.*builtin connectors/);
  assert.equal(refused.calls.length, 1);
});

test("masks token-like text echoed in an error body", async () => {
  const { provider: p } = provider([fail(400, { message: "bad key abcdefghijklmnopqrstuvwxyz0123456789" })]);
  await assert.rejects(p.search({ query: "q" }), error => !error.message.includes("abcdefghijklmnop") && error.message.includes("[redacted]"));
});

test("reports a missing key before any request", async () => {
  const { provider: p, calls } = provider([], { key: "" });
  await rejectsWith(p.search({ query: "q" }), "WEB_PROVIDER_CREDENTIAL_MISSING", /MISTRAL_VIBE_API_KEY/);
  assert.equal(calls.length, 0);
});

test("a failing credential store becomes a structured error", async () => {
  const { provider: p } = provider([], { key: new Error("store locked") });
  await rejectsWith(p.search({ query: "q" }), "WEB_PROVIDER_ERROR", /Could not read/);
});

test("ready answers from credential presence", async () => {
  assert.equal(await provider([]).provider.ready(), true);
  assert.equal(await provider([], { key: "" }).provider.ready(), false);
});

test("cancellation stops at once, before and during a request, without retry", async () => {
  const before = new AbortController();
  before.abort();
  const idle = provider([]);
  await rejectsWith(idle.provider.search({ query: "q" }, before.signal), "WEB_ABORTED");
  assert.equal(idle.calls.length, 0);

  const during = new AbortController();
  let requests = 0;
  const running = createSearchProvider({
    WebError,
    credentials: { configured: async () => true, value: async () => KEY },
    options: () => DEFAULTS,
    fetchImpl: () => {
      requests += 1;
      during.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    },
  });
  await rejectsWith(running.search({ query: "q" }, during.signal), "WEB_ABORTED");
  assert.equal(requests, 1);
});

test("uses the configured model and base URL", async () => {
  const { provider: p, calls } = provider([ok([execution({})])], { options: { model: "mistral-large-4", baseURL: "http://127.0.0.1:9/v1/" } });
  await p.search({ query: "q" });
  assert.equal(calls[0].url, "http://127.0.0.1:9/v1/conversations");
  assert.equal(calls[0].body.model, "mistral-large-4");
});
