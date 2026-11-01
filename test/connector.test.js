import test from "node:test";
import assert from "node:assert/strict";
import { createStarkConnector, normalizeApiBaseUrl, normalizeModels, PUBLIC_PLACEHOLDER_KEY } from "../connector.js";

const syntheticCapability = "a".repeat(64);
const connected = {
  version: 1,
  status: "connected",
  api_base_url: "http://127.0.0.1:18133/v1",
  api_session: "session-test-1",
  models: [
    { id: "qwen3-dense", name: "Qwen3 Dense", context_length: 40960, context_capacity_known: true, max_output_tokens: 4096, tool_calling: true },
    { id: "unknown-context", name: "Unknown", context_length: null, context_capacity_known: false, max_output_tokens: 1024, tool_calling: false },
  ],
};

function createContext() {
  const state = { providers: new Map(), hooks: [], activeHooks: new Set(), transforms: 0, reloads: 0 };
  let providerTransform;
  const ctx = {
    options: { socketPath: "/tmp/stark-test/openwork.sock", expectedBaseURL: "http://127.0.0.1:18133/v1" },
    provider: {
      get: (id) => state.providers.get(id),
      add: (record) => state.providers.set(record.info.id, record),
      remove: (id) => state.providers.delete(id),
      transform: async (fn) => {
        providerTransform = fn;
        state.transforms++;
        fn({ get: ctx.provider.get, add: ctx.provider.add, remove: ctx.provider.remove });
        return { dispose() {} };
      },
      reload: async () => {
        state.reloads++;
        providerTransform?.({ get: ctx.provider.get, add: ctx.provider.add, remove: ctx.provider.remove });
      },
    },
    session: {
      hook: async (name, fn, options) => {
        const registration = { name, fn, options };
        state.hooks.push(registration);
        state.activeHooks.add(registration);
        return { dispose() { state.activeHooks.delete(registration); } };
      },
    },
  };
  return { ctx, state };
}

async function withManualPoll(run) {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const callbacks = [];
  globalThis.setInterval = (callback) => {
    const timer = { active: true, unref() {} };
    callbacks.push({ callback, timer });
    return timer;
  };
  globalThis.clearInterval = (timer) => { timer.active = false; };
  try {
    await run(async () => {
      assert.equal(callbacks.length, 1);
      assert.equal(callbacks[0].timer.active, true);
      callbacks[0].callback();
      await new Promise((resolve) => setImmediate(resolve));
    });
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}

test("validates loopback API URL and omits models with unknown context capacity", () => {
  assert.equal(normalizeApiBaseUrl("http://127.0.0.1:18133/v1"), "http://127.0.0.1:18133/v1");
  assert.equal(normalizeApiBaseUrl("http://127.0.0.1:80/v1"), "http://127.0.0.1/v1");
  assert.equal(normalizeApiBaseUrl("http://127.0.0.1/v1"), "http://127.0.0.1/v1");
  assert.equal(normalizeApiBaseUrl("https://127.0.0.1:18133/v1"), null);
  assert.equal(normalizeApiBaseUrl("http://localhost:18133/v1"), null);
  assert.equal(normalizeApiBaseUrl("http://192.168.1.10:18133/v1"), null);
  assert.equal(normalizeApiBaseUrl("http://127.0.0.1:18133/v1?x=1"), null);
  const result = normalizeModels(connected.models);
  assert.equal(result.omittedUnknownContext, 1);
  assert.deepEqual(result.models, [{ id: "qwen3-dense", name: "Qwen3 Dense", context: 40960, output: 4096, tools: true }]);
  assert.equal(normalizeModels([{ id: "local Qwen 3", name: "Local Qwen 3", context_capacity_known: true, context_length: 4096, max_output_tokens: 512, tool_calling: false }]).models[0].id, "local Qwen 3");
});

test("publishes public model metadata and uses a fresh scoped capability for each chat request", async () => {
  const calls = [];
  const broker = async (_path, operation) => {
    calls.push(operation);
    if (operation === "status") return connected;
    return { ...connected, api_key: syntheticCapability };
  };
  const { ctx, state } = createContext();
  const stop = await createStarkConnector({ requestBroker: broker }).setup(ctx);

  const provider = state.providers.get("stark");
  assert.equal(provider.info.settings.apiKey, PUBLIC_PLACEHOLDER_KEY);
  assert.equal(provider.info.settings.baseURL, connected.api_base_url);
  assert.equal(provider.info.settings.transport, "http");
  assert.deepEqual(provider.models.map((model) => model.modelID), ["qwen3-dense"]);
  assert.deepEqual(provider.models[0].limit, { context: 40960, output: 4096 });
  assert.equal(provider.models[0].settings.transport, "http");
  assert.equal(provider.models[0].capabilities.tools, true);
  assert.deepEqual(state.hooks[0].options, { providerID: "stark" });

  const bodyMarker = "synthetic-body-marker";
  const request = new Request("http://127.0.0.1:18133/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer public-placeholder", "x-api-key": "synthetic-old-auth" },
    body: bodyMarker,
  });
  const event = { model: { providerID: "stark" }, request };
  await state.hooks[0].fn(event);
  assert.equal(event.request.headers.get("authorization"), `Bearer ${syntheticCapability}`);
  assert.equal(event.request.headers.has("x-api-key"), false);
  assert.equal(event.request.redirect, "error");
  assert.equal(await event.request.text(), bodyMarker);

  const second = { model: { providerID: "stark" }, request: new Request("http://127.0.0.1:18133/v1/chat/completions", { method: "POST", body: "second" }) };
  await state.hooks[0].fn(second);
  assert.equal(calls.filter((op) => op === "connection").length, 2);
  assert.equal((await second.request.text()), "second");

  await stop();
});

test("authenticates allowed metadata reads and blocks unexpected routes", async () => {
  const broker = async (_path, operation) => operation === "status" ? connected : { ...connected, api_key: syntheticCapability };
  const { ctx, state } = createContext();
  const stop = await createStarkConnector({ requestBroker: broker }).setup(ctx);
  const hook = state.hooks[0].fn;

  const read = { model: { providerID: "stark" }, request: new Request("http://127.0.0.1:18133/v1/models", { headers: { authorization: "Bearer stale", "api-key": "stale" } }) };
  await hook(read);
  assert.equal(read.request.headers.get("authorization"), `Bearer ${syntheticCapability}`);
  assert.equal(read.request.headers.has("api-key"), false);

  const readModel = { model: { providerID: "stark" }, request: new Request("http://127.0.0.1:18133/v1/models/qwen3-dense%3Asafe") };
  await hook(readModel);
  assert.equal(readModel.request.headers.get("authorization"), `Bearer ${syntheticCapability}`);

  for (const [url, method] of [
    ["http://127.0.0.1:18133/v1/admin", "GET"],
    ["http://127.0.0.1:18133/v1/chat/completions?x=1", "POST"],
    ["http://127.0.0.1:18133/v1/models", "POST"],
    ["http://127.0.0.1:18133/v1/chat/completions", "GET"],
    ["http://127.0.0.1:18134/v1/chat/completions", "POST"],
  ]) {
    await assert.rejects(hook({ model: { providerID: "stark" }, request: new Request(url, { method }) }), /Stark provider request blocked/);
  }
  await stop();
});

test("does not replace a provider record owned by another configuration", async () => {
  const broker = async (_path, operation) => operation === "status" ? connected : { ...connected, api_key: syntheticCapability };
  const { ctx, state } = createContext();
  const existing = { info: { id: "stark", name: "User Stark", package: "other", settings: { apiKey: "user-owned" } }, models: [] };
  state.providers.set("stark", existing);
  const stop = await createStarkConnector({ requestBroker: broker }).setup(ctx);
  assert.equal(state.providers.get("stark"), existing);
  assert.equal(state.hooks.length, 0);
  await stop();
});

test("rejects a broker endpoint that differs from the installed endpoint pin", async () => {
  const broker = async (_path, operation) => operation === "status"
    ? { ...connected, api_base_url: "http://127.0.0.1:18134/v1" }
    : { ...connected, api_base_url: "http://127.0.0.1:18134/v1", api_key: syntheticCapability };
  const { ctx, state } = createContext();
  const stop = await createStarkConnector({ requestBroker: broker }).setup(ctx);
  assert.equal(state.providers.has("stark"), false);
  assert.equal(state.hooks.length, 0);
  await stop();
});

test("accepts a newly rotated session capability and refreshes catalog state asynchronously", async () => {
  const rotated = { ...connected, api_session: "session-test-2" };
  let latestStatus = connected;
  const calls = [];
  const broker = async (_path, operation) => {
    calls.push(operation);
    if (operation === "status") return latestStatus;
    latestStatus = rotated;
    return { ...rotated, api_key: syntheticCapability };
  };
  const { ctx, state } = createContext();
  const stop = await createStarkConnector({ requestBroker: broker }).setup(ctx);
  const requestEvent = {
    model: { providerID: "stark" },
    request: new Request("http://127.0.0.1:18133/v1/chat/completions", { method: "POST", body: "rotation-marker" }),
  };
  await state.hooks[0].fn(requestEvent);
  assert.equal(requestEvent.request.headers.get("authorization"), `Bearer ${syntheticCapability}`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(state.reloads >= 1);
  assert.ok(calls.includes("status"));
  await stop();
});

test("reconciles model replacement through loading, including a text-only model with a Hugging Face ID", async () => {
  await withManualPoll(async (poll) => {
    let latest = { ...connected, models: [connected.models[0]] };
    const replacement = {
      id: "owner/new-model", name: "New Model", context_length: 16384,
      context_capacity_known: true, max_output_tokens: 1024, tool_calling: false,
    };
    const brokerCalls = [];
    const broker = async (_path, operation) => {
      brokerCalls.push(operation);
      return operation === "status" ? latest : { ...latest, api_key: syntheticCapability };
    };
    const { ctx, state } = createContext();
    const stop = await createStarkConnector({ requestBroker: broker }).setup(ctx);
    try {
      assert.deepEqual(state.providers.get("stark").models.map((model) => model.id), ["qwen3-dense"]);
      assert.equal(state.activeHooks.size, 1);

      latest = { ...latest, models: [] };
      await poll();
      assert.equal(state.providers.has("stark"), false);
      assert.equal(state.activeHooks.size, 0);

      latest = { ...latest, models: [replacement] };
      await poll();
      const provider = state.providers.get("stark");
      assert.equal(provider.info.settings.apiKey, PUBLIC_PLACEHOLDER_KEY);
      assert.equal(provider.info.settings.baseURL, connected.api_base_url);
      assert.deepEqual(provider.models.map((model) => model.id), ["owner/new-model"]);
      assert.equal(provider.models[0].modelID, replacement.id);
      assert.equal(provider.models[0].capabilities.tools, false);
      assert.deepEqual(provider.models[0].limit, { context: 16384, output: 1024 });
      assert.equal(state.activeHooks.size, 1);
      assert.equal(brokerCalls.includes("connection"), false);

      const body = JSON.stringify({ model: replacement.id, messages: [{ role: "user", content: "Synthetic model-switch request" }] });
      const event = {
        model: { providerID: "stark", modelID: replacement.id },
        request: new Request("http://127.0.0.1:18133/v1/chat/completions", { method: "POST", body }),
      };
      await [...state.activeHooks][0].fn(event);
      assert.equal(event.request.headers.get("authorization"), `Bearer ${syntheticCapability}`);
      assert.equal(await event.request.text(), body);
      assert.equal(brokerCalls.filter((operation) => operation === "connection").length, 1);

      // Restarting this same model republishes the same public identifier.
      latest = { ...latest, models: [] };
      await poll();
      latest = { ...latest, models: [{ ...replacement }] };
      await poll();
      assert.deepEqual(state.providers.get("stark").models.map((model) => model.id), [replacement.id]);
      assert.equal(state.activeHooks.size, 1);
    } finally {
      await stop();
    }
    assert.equal(state.activeHooks.size, 0);
  });
});

test("retries a failed model-catalog reload even when the replacement status does not change", async () => {
  await withManualPoll(async (poll) => {
    let latest = { ...connected, models: [connected.models[0]] };
    const broker = async (_path, operation) => operation === "status" ? latest : { ...latest, api_key: syntheticCapability };
    const { ctx, state } = createContext();
    const stop = await createStarkConnector({ requestBroker: broker }).setup(ctx);
    const reload = ctx.provider.reload;
    let failNext = true;
    ctx.provider.reload = async () => {
      if (failNext) {
        failNext = false;
        state.reloads++;
        throw new Error("Synthetic catalog reload failure");
      }
      return reload();
    };
    try {
      latest = { ...latest, models: [{
        id: "owner/replacement", name: "Replacement", context_length: 32768,
        context_capacity_known: true, max_output_tokens: 2048, tool_calling: false,
      }] };
      await poll();
      assert.equal(state.reloads, 1);
      assert.deepEqual(state.providers.get("stark").models.map((model) => model.id), ["qwen3-dense"]);

      await poll();
      assert.equal(state.reloads, 2);
      assert.deepEqual(state.providers.get("stark").models.map((model) => model.id), ["owner/replacement"]);
      assert.equal(state.activeHooks.size, 1);
      assert.equal(state.hooks.length, 1);
    } finally {
      await stop();
    }
    assert.equal(state.activeHooks.size, 0);
  });
});

test("swallows a background hook-registration failure and retries on the next poll", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const pollCallbacks = [];
  const connectedStatus = { ...connected };
  let statusCalls = 0;
  let hookAttempts = 0;
  const { ctx, state } = createContext();
  globalThis.setInterval = (callback) => {
    pollCallbacks.push(callback);
    return { unref() {} };
  };
  globalThis.clearInterval = () => {};
  ctx.session.hook = async (name, fn, options) => {
    hookAttempts++;
    if (hookAttempts === 1) throw new Error("synthetic registration failure");
    state.hooks.push({ name, fn, options });
    return { dispose() {} };
  };
  const broker = async (_path, operation) => {
    if (operation === "status") {
      statusCalls++;
      return statusCalls === 1 ? { version: 1, status: "not_connected" } : connectedStatus;
    }
    return { ...connectedStatus, api_key: syntheticCapability };
  };

  try {
    const stop = await createStarkConnector({ requestBroker: broker }).setup(ctx);
    assert.equal(hookAttempts, 0);
    assert.equal(pollCallbacks.length, 1);
    pollCallbacks[0]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(hookAttempts, 1);
    pollCallbacks[0]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(hookAttempts, 2);
    assert.equal(state.hooks.length, 1);
    await stop();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
