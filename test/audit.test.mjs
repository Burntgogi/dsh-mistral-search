import assert from "node:assert/strict";
import { test } from "node:test";
import { createSearchProvider, DEFAULTS } from "../lib/search.js";

class WebError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.code = code;
  }
}

const KEY = "short-key-with.dots";
const BLOCK = "Error executing tool web_search: Tool response from '019df75b-9179-7745-ba07-9a43052c1344' was blocked: prompt injection pattern detected.";
const item = (url, rank) => ({ url, title: `t${rank}`, description: `d${rank}`, snippets: [], date: null, rank });
const execution = (result, query) => ({
  type: "tool.execution",
  name: "web_search",
  ...(query === undefined ? {} : { arguments: JSON.stringify({ query }) }),
  info: { result: typeof result === "string" ? result : JSON.stringify(result) },
});
const citation = { type: "message.output", content: [{ type: "tool_reference", url: "https://c.example/", title: "c" }] };
const ok = outputs => new Response(JSON.stringify({ outputs }), { status: 200 });
const fail = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), { status, headers });

function build(fetchImpl, extra = {}) {
  return createSearchProvider({
    WebError,
    credentials: { configured: async () => true, value: async () => KEY },
    options: () => DEFAULTS,
    fetchImpl,
    ...extra,
  });
}

function replies(...list) {
  const calls = [];
  const provider = build(async (url, init) => {
    calls.push(init);
    return list.shift();
  }, { wait: async () => {} });
  return { provider, calls };
}

/** A request that stays pending until the signal it was given aborts, as a real fetch does. */
const pendingUntilAborted = (url, init) => new Promise((resolve, reject) => {
  init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
});

const hasCode = (promise, code) => assert.rejects(promise, error => {
  assert.equal(error.code, code);
  return true;
});

test("redacts the credential actually used, whatever its shape", async () => {
  const http = replies(fail(400, { message: `key ${KEY} is not valid` }));
  await assert.rejects(http.provider.search({ query: "q" }), error => !error.message.includes(KEY) && error.message.includes("[redacted]"));
  const tool = replies(ok([execution(`Error executing tool web_search: bad key ${KEY}`)]), ok([execution(`Error executing tool web_search: bad key ${KEY}`)]));
  await assert.rejects(tool.provider.search({ query: "q" }), error => !error.message.includes(KEY));
});

test("an explicit block is not hidden by an empty execution", async () => {
  const { provider } = replies(ok([execution({}), execution(BLOCK)]));
  const result = await provider.search({ query: "q" });
  assert.deepEqual(result.sources, []);
  assert.match(result.content, /safety filter blocked/);
});

test("an explicit block is not hidden by citation chunks", async () => {
  const { provider } = replies(ok([execution(BLOCK), citation]));
  const result = await provider.search({ query: "q" });
  assert.deepEqual(result.sources, []);
  assert.match(result.content, /safety filter blocked/);
});

test("a block keeps results from another execution and still says so", async () => {
  const { provider } = replies(ok([execution({ a: item("https://a.example/", 0) }), execution(BLOCK)]));
  const result = await provider.search({ query: "q" });
  assert.equal(result.sources.length, 1);
  assert.match(result.content, /safety filter blocked/);
});

test("mixed failures keep both warnings and successful results in every execution order", async () => {
  const generic = execution("Error executing tool web_search: upstream unavailable");
  const blocked = execution(BLOCK);
  const success = execution({ a: item("https://a.example/", 0) });
  const orders = [
    [generic, blocked, success], [generic, success, blocked],
    [blocked, generic, success], [blocked, success, generic],
    [success, generic, blocked], [success, blocked, generic],
  ];
  let expected;
  for (const outputs of orders) {
    const { provider, calls } = replies(ok(outputs));
    const result = await provider.search({ query: "q" });
    assert.equal(result.sources.length, 1);
    assert.match(result.content, /safety filter blocked/);
    assert.match(result.content, /executions failed.*incomplete/);
    assert.equal(calls.length, 1);
    expected ??= result;
    assert.deepEqual(result, expected);
  }
});

test("a generic execution failure warns alongside successful results in either order", async () => {
  const generic = execution("Error executing tool web_search: upstream unavailable");
  const success = execution({ a: item("https://a.example/", 0) });
  for (const outputs of [[generic, success], [success, generic]]) {
    const { provider, calls } = replies(ok(outputs));
    const result = await provider.search({ query: "q" });
    assert.equal(result.sources.length, 1);
    assert.match(result.content, /executions failed.*incomplete/);
    assert.doesNotMatch(result.content, /safety filter/);
    assert.equal(calls.length, 1);
  }
});

test("all failed executions still report any filter block without retrying", async () => {
  const generic = execution("Error executing tool web_search: upstream unavailable");
  const blocked = execution(BLOCK);
  for (const outputs of [[generic, blocked], [blocked, generic]]) {
    const { provider, calls } = replies(ok(outputs));
    const result = await provider.search({ query: "q" });
    assert.deepEqual(result.sources, []);
    assert.match(result.content, /safety filter blocked/);
    assert.match(result.content, /executions failed/);
    assert.equal(calls.length, 1);
  }
});

test("all generic execution failures are retried once and reported together", async () => {
  const first = execution(`Error executing tool web_search: upstream one rejected ${KEY}`);
  const second = execution("Error executing tool web_search: upstream two unavailable");
  for (const outputs of [[first, second], [second, first]]) {
    const { provider, calls } = replies(ok(outputs), ok(outputs));
    await assert.rejects(provider.search({ query: "q" }), error => {
      assert.equal(error.code, "WEB_PROVIDER_ERROR");
      assert.match(error.message, /upstream one/);
      assert.match(error.message, /upstream two/);
      assert.equal(error.message.includes(KEY), false);
      return true;
    });
    assert.equal(calls.length, 2);
  }
});

test("a readable empty result beside an unreadable one is not conclusive", async () => {
  const { provider } = replies(ok([execution({}), execution("not json")]));
  await hasCode(provider.search({ query: "q" }), "WEB_PROVIDER_ERROR");
});

test("only the filter's own wording counts as a filter block", async () => {
  const text = "Error executing tool web_search: request blocked by upstream rate limit";
  const { provider, calls } = replies(ok([execution(text)]), ok([execution(text)]));
  await assert.rejects(provider.search({ query: "q" }), error => {
    assert.equal(error.code, "WEB_PROVIDER_ERROR");
    assert.match(error.message, /upstream rate limit/);
    return true;
  });
  assert.equal(calls.length, 2);
});

test("recognises the filter wording beyond the length of displayed text", async () => {
  const long = `Error executing tool web_search: ${"x ".repeat(150)}Tool response from 'abc' was blocked: prompt injection pattern detected.`;
  const { provider } = replies(ok([execution(long)]));
  assert.match((await provider.search({ query: "q" })).content, /safety filter blocked/);
});

test("says when the tool ran a different query, without discarding the results", async () => {
  const { provider } = replies(ok([execution({ a: item("https://a.example/", 0) }, "rewritten terms")]));
  const result = await provider.search({ query: "original terms" });
  assert.equal(result.sources.length, 1);
  assert.match(result.content, /different search terms: rewritten terms/);
});

test("adds no note when the tool ran the requested query", async () => {
  const { provider } = replies(ok([execution({ a: item("https://a.example/", 0) }, "same terms")]));
  assert.equal((await provider.search({ query: " same terms " })).content, undefined);
});

test("reads validation reasons from detail without copying the request", async () => {
  const { provider } = replies(fail(422, { detail: [{ msg: "Value error, bad field", input: { inputs: "SECRET QUERY" } }] }));
  await assert.rejects(provider.search({ query: "q" }), error => {
    assert.match(error.message, /Value error, bad field/);
    assert.equal(error.message.includes("SECRET QUERY"), false);
    return true;
  });
});

test("cancelling a pending request ends it through the signal the request was given", async () => {
  const controller = new AbortController();
  const search = build(pendingUntilAborted).search({ query: "q" }, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await hasCode(search, "WEB_ABORTED");
});

test("cancelling while the last failure's body is read reports cancellation", async () => {
  const controller = new AbortController();
  const failing = () => ({
    ok: false,
    status: 503,
    // A long Retry-After means no further attempt, so the search itself must report the cancellation.
    headers: new Headers({ "retry-after": "3600" }),
    json: () => {
      controller.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    },
  });
  await hasCode(build(async () => failing()).search({ query: "q" }, controller.signal), "WEB_ABORTED");
});

test("a credential resolver that cancels synchronously and never settles still ends", async () => {
  const controller = new AbortController();
  const provider = build(() => assert.fail("no request expected"), {
    credentials: {
      configured: async () => true,
      value: () => {
        controller.abort();
        return new Promise(() => {});
      },
    },
  });
  await hasCode(provider.search({ query: "q" }, controller.signal), "WEB_ABORTED");
});

test("cancelling during a running backoff ends the wait", async () => {
  const controller = new AbortController();
  const search = build(async () => fail(503, {}, { "retry-after": "5" })).search({ query: "q" }, controller.signal);
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  await hasCode(search, "WEB_ABORTED");
  assert.ok(Date.now() - started < 1000);
});

test("the attempt timeout ends a stuck request and it is tried once more", async () => {
  let requests = 0;
  const provider = build((url, init) => {
    requests += 1;
    return pendingUntilAborted(url, init);
  }, { attemptTimeoutMs: 20, wait: async () => {} });
  // AbortSignal.timeout does not hold the event loop open, and a real host's server does.
  const keepAlive = setInterval(() => {}, 5);
  try {
    await assert.rejects(provider.search({ query: "q" }), error => {
      assert.equal(error.code, "WEB_PROVIDER_ERROR");
      assert.match(error.message, /timed out/);
      return true;
    });
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(requests, 2);
});

test("default attempts and the longest retry wait fit the host's 30-second budget", async t => {
  const timeouts = [];
  const waits = [];
  const calls = [];
  t.mock.method(AbortSignal, "timeout", ms => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  const provider = build(async (url, init) => {
    calls.push(init);
    return fail(503, {}, { "retry-after": "5" });
  }, { wait: async ms => { waits.push(ms); } });
  await hasCode(provider.search({ query: "q" }), "WEB_PROVIDER_ERROR");
  assert.equal(calls.length, 2);
  assert.deepEqual(timeouts, [12_000, 12_000]);
  assert.deepEqual(waits, [5_000]);
  assert.equal([...timeouts, ...waits].reduce((total, ms) => total + ms, 0), 29_000);
});

test("a baseURL the key must not reach fails before the key is read or a request is sent", async () => {
  const unsafe = [
    "http://api.mistral.ai/v1",
    "http://127.0.0.1.evil.example/v1",
    "http://localhost.evil.example/v1",
    "ftp://api.mistral.ai/v1",
    "https://user:secret@api.mistral.ai/v1",
    "not a url",
    "",
  ];
  for (const baseURL of unsafe) {
    let requests = 0;
    let reads = 0;
    const provider = build(async () => {
      requests++;
      return ok([]);
    }, {
      options: () => ({ ...DEFAULTS, baseURL }),
      credentials: { configured: async () => true, value: async () => { reads++; return KEY; } },
    });
    await assert.rejects(provider.search({ query: "q" }), error => {
      assert.equal(error.code, "WEB_PROVIDER_ERROR");
      assert.match(error.message, /must use HTTPS/);
      assert.equal(error.message.includes("secret"), false);
      return true;
    });
    assert.equal(requests, 0, baseURL);
    assert.equal(reads, 0, baseURL);
  }
});

test("HTTPS and local HTTP addresses are accepted", async () => {
  const safe = [
    "https://api.mistral.ai/v1",
    "https://proxy.example:8443/mistral/",
    "http://localhost:8080/v1",
    "http://127.0.0.1:18923/v1",
    "http://[::1]:8080/v1",
  ];
  for (const baseURL of safe) {
    const urls = [];
    const provider = build(async url => {
      urls.push(url);
      return ok([execution({ a: item("https://a.example/", 0) })]);
    }, { options: () => ({ ...DEFAULTS, baseURL }) });
    const result = await provider.search({ query: "q" });
    assert.equal(result.sources.length, 1, baseURL);
    assert.equal(urls[0], `${baseURL.replace(/\/+$/, "")}/conversations`);
  }
});
