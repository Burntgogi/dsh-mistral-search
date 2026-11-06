/**
 * The credential store when the host offers one, otherwise the launch environment, as built-in
 * providers do. An existing launch snapshot is authoritative: process.env is only for hosts without one.
 */
export function createCredentials(ctx) {
  const ambient = name => {
    const snapshot = ctx.get("launchEnvironment");
    return snapshot === undefined ? process.env[name] : snapshot.get(name)?.value;
  };
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
