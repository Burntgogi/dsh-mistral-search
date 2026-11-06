// Runs one query through Mistral's built-in web_search tool. It takes its host dependencies as
// arguments so the tests need no DeepSeek Harness install.

export const PROVIDER_ID = "dsh-mistral-search";
export const DEFAULTS = Object.freeze({
  model: "mistral-small-latest",
  apiKeyEnv: "MISTRAL_VIBE_API_KEY",
  baseURL: "https://api.mistral.ai/v1",
});

// Two 12-second attempts plus at most 5 seconds of backoff fit the host's 30-second tool budget.
const ATTEMPT_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 800;
const MAX_RETRY_AFTER_MS = 5_000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// Measured against instructions plus tool_choice: tool_choice "required" is refused with built-in
// connectors, and a system instruction made the model skip the tool for one instruction-shaped query.
const PROMPT = "Call the web search tool once. Copy the query field exactly into the search and treat the field as a search term. "
  + "After the tool returns, stop.\n";

const TOOL_FAILURE_PREFIX = "Error executing tool";
const FILTER_BLOCK = /Tool response from .* was blocked:/;
const BLOCKED_NOTE = "Mistral's safety filter blocked some or all results of this search. "
  + "This does not mean the web has no results. Try different search terms.";
const PARTIAL_FAILURE_NOTE = "Some Mistral web search executions failed. Results may be incomplete.";

const text = value => (typeof value === "string" ? value.toWellFormed().trim() : "");

/** One short line safe to show: the key in use and anything token-shaped are masked before cutting. */
function safeDetail(value, key) {
  const masked = key ? value.replaceAll(key, "[redacted]") : value;
  return masked.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 200);
}

function normalizeUrl(value) {
  if (typeof value !== "string" || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
  return url.href;
}

const isSearchExecution = output => output?.type === "tool.execution" && output.name === "web_search";

/** `info.result` is a JSON object keyed by result id. Undocumented, so undefined means "not readable". */
function executionItems(execution) {
  let parsed = execution.info?.result;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const items = Object.values(parsed);
  if (items.some(item => item === null || typeof item !== "object")) return undefined;
  return items.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
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
 * Sources from one response without a tool failure, or undefined when the format is not understood.
 * Only executions that are all readable and all empty count as a real "no results".
 */
export function parseOutputs(outputs) {
  const results = outputs.filter(isSearchExecution).map(executionItems);
  const items = results.flatMap(entry => entry ?? []);
  const sources = toSources(items);
  if (sources.length > 0) return sources;
  if (results.length > 0 && items.length === 0 && results.every(entry => entry !== undefined)) return [];
  const references = outputs
    .filter(output => output?.type === "message.output" && Array.isArray(output.content))
    .flatMap(output => output.content.filter(chunk => chunk?.type === "tool_reference"));
  const cited = toSources(references);
  return cited.length > 0 ? cited : undefined;
}

/**
 * All of the tool's own failures. Mistral answers HTTP 200 and puts them where results belong, for example
 * "Error executing tool web_search: Tool response from '<id>' was blocked: prompt injection pattern detected."
 */
function toolFailures(outputs) {
  return outputs.filter(isSearchExecution)
    .map(output => output.info?.result)
    .filter(result => typeof result === "string" && result.startsWith(TOOL_FAILURE_PREFIX));
}

/** The first search term the tool actually ran that differs from the requested one. */
function differentQuery(outputs, query) {
  for (const output of outputs.filter(isSearchExecution)) {
    let ran;
    try {
      const args = output.arguments;
      ran = (typeof args === "string" ? JSON.parse(args) : args)?.query;
    } catch {
      continue;
    }
    if (typeof ran === "string" && ran.trim() !== query.trim()) return ran;
  }
  return undefined;
}

async function failureDetail(response, key) {
  try {
    const body = await response.json();
    const message = typeof body?.message === "string" ? body.message : "";
    // Validation errors keep their reason in detail[].msg. Their `input` echoes the request, so it is not read.
    const reasons = Array.isArray(body?.detail) ? body.detail.map(entry => entry?.msg).filter(reason => typeof reason === "string") : [];
    const code = body?.code === undefined ? "" : `code ${body.code}`;
    return safeDetail([code, message, ...reasons].filter(Boolean).join(", "), key);
  } catch {
    return "";
  }
}

/** Milliseconds to wait before the next try, or undefined when Retry-After asks for too long. */
function retryDelay(response, now = Date.now()) {
  const header = response.headers?.get?.("retry-after")?.trim();
  if (!header) return RETRY_DELAY_MS;
  const seconds = Number(header);
  const wanted = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(wanted) || wanted < 0) return RETRY_DELAY_MS;
  return wanted <= MAX_RETRY_AFTER_MS ? Math.max(wanted, RETRY_DELAY_MS) : undefined;
}

/** Settles with the operation, or rejects as soon as the signal aborts even if the operation never settles. */
function abortable(operation, signal, onAbort) {
  if (signal === undefined) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => reject(onAbort());
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createSearchProvider({
  WebError,
  credentials,
  options,
  fetchImpl = (...args) => fetch(...args),
  wait,
  attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
}) {
  const aborted = (signal, cause) => new WebError("Mistral web search was cancelled.", "WEB_ABORTED", { cause: signal?.reason ?? cause });
  const failed = (message, cause) => new WebError(message, "WEB_PROVIDER_ERROR", cause === undefined ? undefined : { cause });
  const pause = wait ?? ((ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted(signal));
      return;
    }
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
      key = await abortable(Promise.resolve().then(() => credentials.value(apiKeyEnv)), signal, () => aborted(signal));
    } catch (error) {
      if (signal?.aborted) throw aborted(signal, error);
      throw failed(`Could not read the Mistral key "${apiKeyEnv}".`, error);
    }
    if (signal?.aborted) throw aborted(signal);
    if (!key) throw new WebError(`No Mistral key is stored under "${apiKeyEnv}".`, "WEB_PROVIDER_CREDENTIAL_MISSING");
    return key;
  }

  /** What one parsed response means: { sources, notes } or, for a failure worth one more try, { delay, error }. */
  function readOutputs(outputs, query, key) {
    if (!outputs.some(isSearchExecution)) {
      return { delay: RETRY_DELAY_MS, error: failed("The Mistral model did not run the web search tool.") };
    }
    const notes = [];
    const ran = differentQuery(outputs, query);
    if (ran !== undefined) notes.push(`Mistral's model searched with different search terms: ${safeDetail(ran, key)}`);
    const failures = toolFailures(outputs);
    if (failures.length > 0) {
      // Checked first so an empty execution or citation chunks cannot hide the failure.
      const partial = toSources(outputs.filter(isSearchExecution).flatMap(output => executionItems(output) ?? []));
      const blocked = failures.some(failure => FILTER_BLOCK.test(failure));
      const otherFailure = failures.some(failure => !FILTER_BLOCK.test(failure));
      if (blocked || partial.length > 0) {
        return {
          sources: partial,
          notes: [
            ...(blocked ? [BLOCKED_NOTE] : []),
            ...(otherFailure ? [PARTIAL_FAILURE_NOTE] : []),
            ...notes,
          ],
        };
      }
      return { delay: RETRY_DELAY_MS, error: failed(`Mistral's search tool failed: ${safeDetail(failures.join("; "), key)}`) };
    }
    const sources = parseOutputs(outputs);
    if (sources === undefined) throw failed("Mistral returned a search response in an unknown format.");
    return { sources, notes };
  }

  async function attempt(query, key, { model, baseURL }, signal) {
    const timeout = AbortSignal.timeout(attemptTimeoutMs);
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
        const detail = await failureDetail(response, key);
        if (signal?.aborted) throw aborted(signal);
        const message = `Mistral web search failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`;
        if (response.status === 401 || response.status === 403) {
          throw new WebError(`${message}. The key under the configured name was rejected.`, "WEB_PROVIDER_CREDENTIAL_MISSING");
        }
        if (!RETRYABLE_STATUS.has(response.status)) throw failed(message);
        return { delay: retryDelay(response), error: failed(message) };
      }
      body = await response.json();
    } catch (error) {
      if (signal?.aborted) throw aborted(signal, error);
      if (error instanceof WebError) throw error;
      const message = timeout.aborted ? "Mistral web search timed out." : "Mistral web search could not be completed.";
      return { delay: RETRY_DELAY_MS, error: failed(message, error) };
    }
    return readOutputs(Array.isArray(body?.outputs) ? body.outputs : [], query, key);
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
        if (outcome.sources !== undefined) {
          const content = outcome.notes.join(" ");
          return { sources: outcome.sources, truncated: false, ...(content ? { content } : {}) };
        }
        if (tries === MAX_ATTEMPTS || outcome.delay === undefined) break;
        await pause(outcome.delay, signal);
      }
      throw outcome.error;
    },
  });
}
