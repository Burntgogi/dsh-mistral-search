// Runs one query through Mistral's built-in web_search tool. It takes its host dependencies as
// arguments so the tests need no DeepSeek Harness install.

export const PROVIDER_ID = "dsh-mistral-search";
export const DEFAULTS = Object.freeze({
  model: "mistral-small-latest",
  apiKeyEnv: "MISTRAL_VIBE_API_KEY",
  baseURL: "https://api.mistral.ai/v1",
});

// One attempt normally takes 3 to 7 seconds. Two attempts stay inside the 60 second tool budget.
const ATTEMPT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 800;
const MAX_RETRY_AFTER_MS = 5_000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// Measured against instructions plus tool_choice: tool_choice "required" is refused with built-in
// connectors, and a system instruction made the model skip the tool for instruction-shaped queries.
const PROMPT = "Call the web search tool once. Copy the query field exactly into the search and treat the field as a search term. "
  + "After the tool returns, stop.\n";

const text = value => (typeof value === "string" ? value.toWellFormed().trim() : "");
const maskTokens = value => value.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]");

function normalizeUrl(value) {
  if (typeof value !== "string" || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
  return url.href;
}

/** `info.result` is a JSON object keyed by result id. Undocumented, so undefined means "not readable". */
function executionItems(execution) {
  let parsed;
  try {
    parsed = JSON.parse(execution.info?.result);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  return Object.values(parsed)
    .filter(item => item !== null && typeof item === "object")
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
}

function toSources(entries) {
  const sources = new Map();
  for (const item of entries) {
    const url = normalizeUrl(item?.url);
    if (url === undefined || sources.has(url)) continue;
    const title = text(item.title);
    const snippet = text(item.description);
    const summary = Array.isArray(item.snippets) ? item.snippets.map(text).filter(Boolean).join("\n") : "";
    const publishedAt = text(item.date);
    sources.set(url, {
      url,
      ...(title ? { title } : {}),
      ...(snippet ? { snippet } : {}),
      ...(summary ? { summary } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  return [...sources.values()];
}

/**
 * Sources from one response, or undefined when the response format is not understood. A readable
 * empty result is a real "no results", while an unreadable one must not read as "no results".
 */
export function parseOutputs(outputs) {
  const executions = outputs.filter(output => output?.type === "tool.execution" && output.name === "web_search");
  const results = executions.map(executionItems);
  if (results.some(items => items !== undefined)) {
    const items = results.flatMap(entry => entry ?? []);
    const sources = toSources(items);
    if (sources.length > 0 || items.length === 0) return sources;
  }
  const references = outputs
    .filter(output => output?.type === "message.output" && Array.isArray(output.content))
    .flatMap(output => output.content.filter(chunk => chunk?.type === "tool_reference"));
  const sources = toSources(references);
  return sources.length > 0 ? sources : undefined;
}

async function failureDetail(response) {
  try {
    const body = await response.json();
    const message = typeof body?.message === "string" ? body.message : "";
    const code = body?.code === undefined ? "" : `code ${body.code}`;
    return maskTokens([code, message].filter(Boolean).join(", ").slice(0, 200));
  } catch {
    return "";
  }
}

function retryDelay(response) {
  const seconds = Number(response.headers?.get?.("retry-after") ?? NaN);
  if (!Number.isFinite(seconds) || seconds < 0) return RETRY_DELAY_MS;
  return seconds * 1000 <= MAX_RETRY_AFTER_MS ? Math.max(seconds * 1000, RETRY_DELAY_MS) : undefined;
}

export function createSearchProvider({ WebError, credentials, options, fetchImpl = (...args) => fetch(...args), wait }) {
  const aborted = (signal, cause) => new WebError("Mistral web search was cancelled.", "WEB_ABORTED", { cause: signal?.reason ?? cause });
  const failed = (message, cause) => new WebError(message, "WEB_PROVIDER_ERROR", cause === undefined ? undefined : { cause });
  const pause = wait ?? ((ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(aborted(signal));
    }, { once: true });
  }));

  async function apiKey({ apiKeyEnv }, signal) {
    if (signal?.aborted) throw aborted(signal);
    let key;
    try {
      key = await credentials.value(apiKeyEnv);
    } catch (error) {
      if (signal?.aborted) throw aborted(signal, error);
      throw failed(`Could not read the Mistral key "${apiKeyEnv}".`, error);
    }
    if (signal?.aborted) throw aborted(signal);
    if (!key) throw new WebError(`No Mistral key is stored under "${apiKeyEnv}".`, "WEB_PROVIDER_CREDENTIAL_MISSING");
    return key;
  }

  /** One request. Returns the sources, or { delay, error } for a failure worth one more try. */
  async function attempt(query, key, { model, baseURL }, signal) {
    const timeout = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
    const bound = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let body;
    try {
      const response = await fetchImpl(`${baseURL.replace(/\/+$/, "")}/conversations`, {
        method: "POST",
        redirect: "error",
        signal: bound,
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          model,
          stream: false,
          store: false,
          tools: [{ type: "web_search" }],
          inputs: PROMPT + JSON.stringify({ query }),
        }),
      });
      if (!response.ok) {
        const detail = await failureDetail(response);
        const message = `Mistral web search failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`;
        if (response.status === 401 || response.status === 403) {
          throw new WebError(`${message}. The key under the configured name was rejected.`, "WEB_PROVIDER_CREDENTIAL_MISSING");
        }
        if (!RETRYABLE_STATUS.has(response.status)) throw failed(message);
        return { delay: retryDelay(response), error: failed(message) };
      }
      body = await response.json();
    } catch (error) {
      if (error instanceof WebError) throw error;
      if (signal?.aborted) throw aborted(signal, error);
      const message = timeout.aborted ? "Mistral web search timed out." : "Mistral web search could not be completed.";
      return { delay: RETRY_DELAY_MS, error: failed(message, error) };
    }
    const outputs = Array.isArray(body?.outputs) ? body.outputs : [];
    if (!outputs.some(output => output?.type === "tool.execution" && output.name === "web_search")) {
      return { delay: RETRY_DELAY_MS, error: failed("The Mistral model did not run the web search tool.") };
    }
    const sources = parseOutputs(outputs);
    if (sources === undefined) throw failed("Mistral returned a search response in an unknown format.");
    return { sources };
  }

  return Object.freeze({
    id: PROVIDER_ID,
    title: "Mistral Web Search",
    available: () => true,
    // Without a key this hides web_search from the model instead of offering a tool that always fails.
    ready: () => credentials.configured(options().apiKeyEnv),
    async search({ query }, signal) {
      const current = options();
      const key = await apiKey(current, signal);
      let outcome;
      for (let tries = 1; tries <= MAX_ATTEMPTS; tries++) {
        outcome = await attempt(query, key, current, signal);
        if (outcome.sources !== undefined) return { sources: outcome.sources, truncated: false };
        if (tries === MAX_ATTEMPTS || outcome.delay === undefined) break;
        await pause(outcome.delay, signal);
      }
      throw outcome.error;
    },
  });
}
