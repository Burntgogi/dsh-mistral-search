import assert from "node:assert/strict";
import { test } from "node:test";
import { createCredentials } from "../lib/credentials.js";

const NAME = "DSH_MISTRAL_SEARCH_TEST_KEY";
const context = services => ({ get: name => services[name] });
const snapshot = values => ({ get: name => (name in values ? { value: values[name] } : undefined) });

test("the credential store wins when the host offers one", async () => {
  const store = { describe: async () => ({ configured: true }), resolve: async () => ({ value: "from-store" }) };
  const credentials = createCredentials(context({ credentials: store, launchEnvironment: snapshot({ [NAME]: "from-env" }) }));
  assert.equal(await credentials.configured(NAME), true);
  assert.equal(await credentials.value(NAME), "from-store");
});

test("an unreadable store reads as not configured", async () => {
  const store = {
    describe: async () => {
      throw new Error("locked");
    },
  };
  assert.equal(await createCredentials(context({ credentials: store })).configured(NAME), false);
});

test("without a store the launch snapshot is used", async () => {
  const credentials = createCredentials(context({ launchEnvironment: snapshot({ [NAME]: "from-snapshot" }) }));
  assert.equal(await credentials.configured(NAME), true);
  assert.equal(await credentials.value(NAME), "from-snapshot");
});

test("a snapshot without the name does not fall through to a later process.env", async () => {
  process.env[NAME] = "added-after-launch";
  try {
    const credentials = createCredentials(context({ launchEnvironment: snapshot({}) }));
    assert.equal(await credentials.configured(NAME), false);
    assert.equal(await credentials.value(NAME), undefined);
  } finally {
    delete process.env[NAME];
  }
});

test("a host without a snapshot reads process.env", async () => {
  process.env[NAME] = "from-process";
  try {
    assert.equal(await createCredentials(context({})).value(NAME), "from-process");
  } finally {
    delete process.env[NAME];
  }
});
