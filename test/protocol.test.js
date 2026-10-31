import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestBroker, BrokerProtocolError } from "../protocol.js";

const syntheticCapability = "b".repeat(64);

async function withBroker(handler, run) {
  const directory = await mkdtemp(join(tmpdir(), "stark-openwork-test-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "broker.sock");
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { input += chunk; });
    socket.on("end", () => {
      try {
        const request = JSON.parse(input);
        socket.end(`${JSON.stringify(handler(request))}\n`);
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, (error) => error ? reject(error) : resolve()));
  try {
    await run(socketPath);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test("sends only the bounded versioned operation and parses a single JSON line", async () => {
  await withBroker((request) => ({ version: 1, status: "connected", operation: request.operation }), async (socketPath) => {
    const response = await requestBroker(socketPath, "status");
    assert.deepEqual(response, { version: 1, status: "connected", operation: "status" });
  });
});

test("rejects malformed or multi-line broker responses without exposing data", async () => {
  await withBroker(() => ({ version: 1, status: "connected", api_key: syntheticCapability }), async (socketPath) => {
    await assert.rejects(requestBroker(socketPath, "status", {
      connect: () => {
        const socket = {
          setTimeout() {},
          on(event, callback) {
            if (event === "connect") queueMicrotask(callback);
            if (event === "data") queueMicrotask(() => callback(Buffer.from("{}\n{}\n")));
            if (event === "end") queueMicrotask(callback);
            return this;
          },
          end() {},
          destroy() {},
        };
        return socket;
      },
      validateSocketPath: async () => {},
    }), BrokerProtocolError);
    assert.ok(socketPath.endsWith("broker.sock"));
  });
});

test("rejects unsupported operations with a generic error", async () => {
  await assert.rejects(requestBroker("/tmp/not-used", "secret"), BrokerProtocolError);
});

test("enforces the absolute response deadline against a steadily trickling broker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stark-openwork-drip-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "broker.sock");
  const clients = new Set();
  const timers = new Map();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => {
      clients.delete(socket);
      clearInterval(timers.get(socket));
    });
    socket.on("end", () => {
      socket.write("{");
      timers.set(socket, setInterval(() => socket.write(" "), 15));
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, (error) => error ? reject(error) : resolve()));
  const started = Date.now();
  let watchdog;
  try {
    await assert.rejects(Promise.race([
      requestBroker(socketPath, "status", { timeoutMs: 100 }),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error("broker deadline did not fire")), 500); }),
    ]), BrokerProtocolError);
    assert.ok(Date.now() - started < 400);
  } finally {
    clearTimeout(watchdog);
    for (const socket of clients) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
