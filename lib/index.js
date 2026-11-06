import { WebError } from "@deepseek-ai/dsh-web";
import z from "@deepseek-ai/schemastery";
import { createSearchProvider, DEFAULTS, PROVIDER_ID } from "./search.js";

export const name = PROVIDER_ID;
// The credentials service is optional: headless profiles run without it, and a required
// inject would leave the pinned provider unregistered there.
export const inject = ["web"];
export const Config = z.object({
  model: z.string().default(DEFAULTS.model).description("Mistral model that runs the search. It must accept built-in connectors."),
  apiKeyEnv: z.string().role("credential-ref").default(DEFAULTS.apiKeyEnv).description("Credential name that holds the Mistral key. Never the key itself."),
  baseURL: z.string().default(DEFAULTS.baseURL).description("Mistral API base URL."),
});

/** The credential store when the host offers one, otherwise the launch environment, as built-in providers do. */
function createCredentials(ctx) {
  const ambient = name => ctx.get("launchEnvironment")?.get(name)?.value ?? process.env[name];
  return {
    async configured(name) {
      const store = ctx.get("credentials");
      if (store === undefined) return Boolean(ambient(name));
      try {
        return (await store.describe(name)).configured === true;
      } catch {
        return false;
      }
    },
    async value(name) {
      const store = ctx.get("credentials");
      if (store === undefined) return ambient(name) || undefined;
      return (await store.resolve(name))?.value || undefined;
    },
  };
}

export function apply(ctx, config) {
  ctx.web.registerSearchProvider(createSearchProvider({
    WebError,
    credentials: createCredentials(ctx),
    // A path or link install gets no Config defaults, so empty values fall back here.
    options: () => ({
      model: config?.model || DEFAULTS.model,
      apiKeyEnv: config?.apiKeyEnv || DEFAULTS.apiKeyEnv,
      baseURL: config?.baseURL || DEFAULTS.baseURL,
    }),
  }));
}
