import { requestBroker } from "./protocol.js";

export const PLUGIN_ID = "stark-openwork-provider";
export const PROVIDER_ID = "stark";
export const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible";
export const PUBLIC_PLACEHOLDER_KEY = "stark-openwork-connector-managed";
export const POLL_INTERVAL_MS = 5_000;

const SESSION_PATTERN = /^[A-Za-z0-9._~-]{1,256}$/;
const API_KEY_PATTERN = /^[a-f0-9]{64}$/;
const GET_PATHS = new Set(["/v1/models", "/v1/health", "/v1/capabilities"]);
const CHAT_PATH = "/v1/chat/completions";
const PRIVATE_AUTH_HEADERS = ["api-key", "x-api-key", "x-goog-api-key"];

function safeName(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function normalizeApiBaseUrl(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "/v1") return null;
    return `${url.origin}/v1`;
  } catch {
    return null;
  }
}

function validModelMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!(safeName(value.id)
    && safeName(value.name)
    && typeof value.context_capacity_known === "boolean"
    && Number.isSafeInteger(value.max_output_tokens)
    && value.max_output_tokens > 0
    && typeof value.tool_calling === "boolean")) return false;
  if (!value.context_capacity_known) return true;
  return Number.isSafeInteger(value.context_length)
    && value.context_length > 0
    && value.max_output_tokens <= value.context_length;
}

function normalizeModels(value) {
  if (!Array.isArray(value) || value.length > 256) return { models: [], omittedUnknownContext: 0 };
  const models = [];
  const seen = new Set();
  let omittedUnknownContext = 0;
  for (const model of value) {
    if (!validModelMetadata(model) || seen.has(model.id)) continue;
    seen.add(model.id);
    if (!model.context_capacity_known) {
      omittedUnknownContext++;
      continue;
    }
    models.push({
      id: model.id,
      name: model.name,
      context: model.context_length,
      output: model.max_output_tokens,
      tools: model.tool_calling,
    });
  }
  return { models, omittedUnknownContext };
}

function normalizeStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) return unavailableStatus();
  if (value.status === "not_connected") return { status: "not_connected", apiBaseUrl: null, apiSession: null, models: [], omittedUnknownContext: 0 };
  if (value.status !== "connected") return unavailableStatus();
  const apiBaseUrl = normalizeApiBaseUrl(value.api_base_url);
  if (!apiBaseUrl || typeof value.api_session !== "string" || !SESSION_PATTERN.test(value.api_session)) return unavailableStatus();
  const normalized = normalizeModels(value.models);
  return {
    status: "connected",
    apiBaseUrl,
    apiSession: value.api_session,
    models: normalized.models,
    omittedUnknownContext: normalized.omittedUnknownContext,
  };
}

function unavailableStatus() {
  return { status: "unavailable", apiBaseUrl: null, apiSession: null, models: [], omittedUnknownContext: 0 };
}

function safeFingerprint(status) {
  return JSON.stringify({
    status: status.status,
    apiBaseUrl: status.apiBaseUrl,
    apiSession: status.apiSession,
    models: status.models,
    omittedUnknownContext: status.omittedUnknownContext,
  });
}

function modelRecord(model) {
  return {
    id: model.id,
    modelID: model.id,
    providerID: PROVIDER_ID,
    name: model.name,
    capabilities: { tools: model.tools, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: model.context, output: model.output },
  };
}

function providerRecord(status) {
  if (status.status !== "connected" || !status.apiBaseUrl || status.models.length === 0) return null;
  return {
    info: {
      id: PROVIDER_ID,
      name: "Stark",
      activation: "enabled",
      package: PROVIDER_PACKAGE,
      settings: {
        baseURL: status.apiBaseUrl,
        provider: PROVIDER_ID,
        apiKey: PUBLIC_PLACEHOLDER_KEY,
        transport: "http",
      },
    },
    models: status.models.map((model) => ({ ...modelRecord(model), settings: { transport: "http" } })),
  };
}

function existingProviderInfo(record) {
  if (!record || typeof record !== "object") return null;
  if (record.provider && typeof record.provider === "object") return record.provider;
  if (record.info && typeof record.info === "object") return record.info;
  return record;
}

function ownsProvider(record) {
  const info = existingProviderInfo(record);
  return info?.id === PROVIDER_ID
    && info?.package === PROVIDER_PACKAGE
    && info?.settings?.apiKey === PUBLIC_PLACEHOLDER_KEY;
}

function publish(editor, status) {
  const existing = editor.get(PROVIDER_ID);
  if (existing && !ownsProvider(existing)) return false;
  const record = providerRecord(status);
  if (record) editor.add(record);
  else if (existing) editor.remove(PROVIDER_ID);
  return Boolean(record);
}

function requestMatchesBase(request, apiBaseUrl) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  const base = new URL(apiBaseUrl);
  return url.origin === base.origin && !url.username && !url.password && !url.search && !url.hash;
}

function replaceRequest(event, authorization) {
  const request = new Request(event.request, { redirect: "error" });
  for (const header of PRIVATE_AUTH_HEADERS) request.headers.delete(header);
  if (authorization) request.headers.set("Authorization", authorization);
  else request.headers.delete("Authorization");
  event.request = request;
}

function isSafeReadRequest(request, baseUrl) {
  if (request.method !== "GET" || !requestMatchesBase(request, baseUrl)) return false;
  const url = new URL(request.url);
  if (GET_PATHS.has(url.pathname)) return true;
  return /^\/v1\/models\/[^/]{1,768}$/.test(url.pathname);
}

function isChatRequest(request, baseUrl) {
  if (request.method !== "POST" || !requestMatchesBase(request, baseUrl)) return false;
  return new URL(request.url).pathname === CHAT_PATH;
}

function authBlocked() {
  return new Error("Stark provider request blocked");
}

export function createStarkConnector(options = {}) {
  const broker = options.requestBroker ?? requestBroker;

  return {
    id: PLUGIN_ID,
    async setup(ctx) {
      const socketPath = ctx.options?.socketPath;
      if (typeof socketPath !== "string" || !socketPath) throw new Error("Stark connection is not configured");
      const expectedApiBaseUrl = normalizeApiBaseUrl(ctx.options?.expectedBaseURL);
      if (!expectedApiBaseUrl) throw new Error("Stark API endpoint is not configured");
      if (typeof ctx.provider?.transform !== "function" || typeof ctx.provider?.reload !== "function") {
        throw new Error("OpenCode provider API is unavailable");
      }
      if (typeof ctx.session?.hook !== "function") throw new Error("OpenCode request hook API is unavailable");

      let status = unavailableStatus();
      let statusRevision = 0;
      let appliedFingerprint = "";
      let refreshInFlight = null;
      let providerActive = false;
      let hookRegistration = null;
      let stopped = false;
      let interval;

      const statusChanged = (next) => {
        status = next;
        statusRevision++;
      };

      const refresh = async () => {
        if (stopped) return;
        if (refreshInFlight) return refreshInFlight;
        refreshInFlight = (async () => {
          const observedRevision = statusRevision;
          let next;
          try {
            next = normalizeStatus(await broker(socketPath, "status"));
          } catch {
            next = unavailableStatus();
          }
          if (observedRevision !== statusRevision) return;
          if (next.status === "connected" && next.apiBaseUrl !== expectedApiBaseUrl) next = unavailableStatus();
          statusChanged(next);
          const fingerprint = safeFingerprint(status);
          if (fingerprint === appliedFingerprint) return;
          try {
            await ctx.provider.reload();
            appliedFingerprint = fingerprint;
          } catch {
            // Keep the fingerprint stale so the next poll retries the registry update.
          }
        })().finally(() => { refreshInFlight = null; });
        return refreshInFlight;
      };

      const scheduleRefresh = () => {
        queueMicrotask(() => {
          const pending = refreshInFlight;
          if (pending) {
            void pending.then(() => refresh(), () => refresh()).catch(() => {});
          } else {
            void refresh().catch(() => {});
          }
        });
      };

      const getCapability = async () => {
        if (status.status !== "connected" || !status.apiBaseUrl || !status.apiSession) throw authBlocked();
        let value;
        try {
          value = await broker(socketPath, "connection");
        } catch {
          throw authBlocked();
        }
        if (!value || value.version !== 1 || value.status !== "connected"
          || normalizeApiBaseUrl(value.api_base_url) !== status.apiBaseUrl
          || typeof value.api_session !== "string" || !SESSION_PATTERN.test(value.api_session)
          || typeof value.api_key !== "string" || !API_KEY_PATTERN.test(value.api_key)) {
          throw authBlocked();
        }
        let current;
        if (Array.isArray(value.models)) {
          current = normalizeStatus(value);
        } else {
          current = { ...status, apiSession: value.api_session };
        }
        if (current.status !== "connected" || current.apiBaseUrl !== expectedApiBaseUrl) throw authBlocked();
        if (safeFingerprint(current) !== safeFingerprint(status)) {
          statusChanged(current);
          scheduleRefresh();
        }
        return value.api_key;
      };

      const handleRequest = async (event) => {
        if (event.model?.providerID !== PROVIDER_ID || !providerActive) return;
        if (status.status !== "connected" || !status.apiBaseUrl) throw authBlocked();
        if (isSafeReadRequest(event.request, status.apiBaseUrl)) {
          const key = await getCapability();
          replaceRequest(event, `Bearer ${key}`);
          return;
        }
        if (!isChatRequest(event.request, status.apiBaseUrl)) throw authBlocked();
        const key = await getCapability();
        replaceRequest(event, `Bearer ${key}`);
      };

      try {
        statusChanged(normalizeStatus(await broker(socketPath, "status")));
      } catch {
        statusChanged(unavailableStatus());
      }
      if (status.status === "connected" && status.apiBaseUrl !== expectedApiBaseUrl) statusChanged(unavailableStatus());

      // OpenCode batches provider transforms during boot: their callback can
      // run only after setup returns. Install authentication first, so the
      // first selectable model cannot send the public placeholder as a key.
      // Keep the scoped hook for the full lifetime; it leaves foreign providers
      // untouched while providerActive is false, including deferred reloads.
      hookRegistration = await ctx.session.hook("http.request", handleRequest, { providerID: PROVIDER_ID });
      let providerRegistration;
      try {
        providerRegistration = await ctx.provider.transform((editor) => { providerActive = publish(editor, status); });
      } catch (error) {
        stopped = true;
        await Promise.allSettled([hookRegistration?.dispose?.()]);
        throw error;
      }
      appliedFingerprint = safeFingerprint(status);
      interval = setInterval(() => { void refresh().catch(() => {}); }, POLL_INTERVAL_MS);
      interval.unref?.();

      return async () => {
        stopped = true;
        if (interval) clearInterval(interval);
        await Promise.allSettled([
          hookRegistration?.dispose?.(),
          providerRegistration?.dispose?.(),
        ]);
      };
    },
  };
}

export { normalizeModels, normalizeStatus, providerRecord };
