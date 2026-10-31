# Stark provider for OpenWork

This repository contains a dependency-free OpenCode V2 plugin that discovers Stark's local model catalog through an owner-private Unix domain socket. It publishes compatible models with `ctx.provider.transform()` and obtains a bearer capability for Stark's API only while OpenCode sends a model request.

The plugin never reads the Stark master key. It receives the broker's reusable, short-lived capability into the outgoing request's in-memory authorization header only; it does not cache the capability or store it in OpenCode configuration or plugin storage.

## Connect from OpenWork

Open the official OpenWork app with a local workspace, then in Stark open **Connection Details** and choose **Connect to OpenWork**. If Stark changes OpenWork's configuration, reopen OpenWork and select **Stark** in its model picker. You do not need to install this package manually, use a credential helper, enter a key, or edit OpenCode configuration. Stark bundles and pins this connector with the app.

The connector is maintained in this separate repository; the installed user flow is the Stark button. The configuration fragment below illustrates the public metadata Stark manages. It is not a manual setup instruction or a complete `opencode.jsonc` file.

## Current integration boundary

OpenWork v0.18.63 bundles OpenCode V2, which supports provider transforms and `http.request` hooks. The connector is loaded through OpenCode's native global `opencode.jsonc` plugin configuration, in the configuration directory discovered from the running OpenCode process's public `OPENCODE_CONFIG_DIR`. The Stark installer adds only this plugin's local package path and public socket path entry while preserving other JSONC entries. OpenWork must be reopened once after installation so the bundled OpenCode process loads the plugin. No OpenWork fork or API token is required.

The plugin entry contains only public metadata:

```json
{
  "package": "file:///absolute/path/to/stark-openwork/server.js",
  "options": {
    "socketPath": "/tmp/stark-<uid>-<service-hash>/openwork.sock",
    "starkConnector": "com.starkengine.openwork/v1",
    "expectedBaseURL": "http://127.0.0.1:18133/v1"
  }
}
```

The public socket path may be stored in the plugin entry. The Stark master key and the short-lived capability must never be stored in plugin options, provider settings, auth storage, environment variables, or process arguments.

## Broker contract

The plugin sends one newline-delimited JSON request per Unix socket connection. Requests are limited to 256 bytes; responses are limited to 64 KiB; each operation has a two-second timeout.

```json
{"version":1,"operation":"status"}
{"version":1,"operation":"connection"}
```

`status` returns public provider metadata:

```json
{
  "version": 1,
  "status": "connected",
  "api_base_url": "http://127.0.0.1:18133/v1",
  "api_session": "opaque-session-identity",
  "models": [
    {
      "id": "qwen3-dense",
      "name": "Qwen3 Dense",
      "context_length": 40960,
      "context_capacity_known": true,
      "max_output_tokens": 4096,
      "tool_calling": true
    }
  ]
}
```

`connection` returns the same public identity plus `api_key`, a 64-character lowercase hexadecimal bearer capability with a renewable 120-second admission lease. Stark issues it only after verifying the expected OpenCode sidecar, associates the grant with that process identity and current API session, and limits its use to the Stark local API. The broker renews the same token when requested after 30 seconds. The bearer remains transferable if exposed while valid; process identity gates issuance but is not a kernel binding on later HTTP requests. An expired lease does not cancel a request already admitted by the API; explicit revocation cancels active requests. The broker keeps the Stark master key inside the Stark process and does not log credentials. The plugin does not log broker errors or request content.

If Stark restarts between catalog polls, the first request may receive a fresh session capability directly from the broker. The plugin uses it for that request and schedules catalog reconciliation asynchronously.

Models without a declared context capacity or output limit are omitted. The plugin does not invent token limits. It advertises tool calling only when the broker reports `tool_calling: true`.

## Request behavior

The provider uses OpenCode's OpenAI-compatible SDK package and the broker's exact loopback `/v1` endpoint. The `http.request` hook only permits these routes:

- `GET /v1/models`, `GET /v1/models/{id}`, `GET /v1/health`, and `GET /v1/capabilities`, with the ephemeral capability.
- `POST /v1/chat/completions`, where the hook replaces authorization with the ephemeral capability and sets redirect handling to `error`.

The hook does not read or rewrite request bodies, so OpenCode's JSON payload and streaming body pass through unchanged. It rejects unexpected provider URLs, methods, paths, query strings, and fragments.

## Development

Run the dependency-free unit suite with `npm test` or `node --test`. These tests use a mock Unix socket and synthetic capabilities only; they do not contact Stark or OpenWork.

## Provenance

The plugin targets OpenCode V2 plugin APIs bundled by OpenWork v0.18.63 (OpenCode 2.0.26). OpenWork's source documents its provider editor and uses `ctx.provider.transform(editor => editor.add(...))` in `packages/opencode-plugin/src/desktop.ts`. OpenCode's pinned `v2.0.26` provider schema defines `Provider.Info` and `Model.Info`, and its plugin API defines `ctx.session.hook("http.request", ...)`.

- [OpenWork v0.18.63 source](https://github.com/different-ai/openwork/tree/v0.18.63)
- [OpenCode V2.0.26 provider plugin API](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/plugin/src/promise/provider.ts)
- [OpenCode V2.0.26 session hook API](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/plugin/src/promise/session.ts)
- [OpenCode V2.0.26 model schema](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/schema/src/model.ts)
