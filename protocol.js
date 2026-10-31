import { connect } from "node:net";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export const MAX_REQUEST_BYTES = 256;
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const BROKER_TIMEOUT_MS = 2_000;

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const OPERATIONS = new Set(["status", "connection"]);

export class BrokerProtocolError extends Error {
  constructor() {
    super("Stark connection unavailable");
    this.name = "BrokerProtocolError";
  }
}

export async function validatePrivateSocketPath(socketPath) {
  if (typeof socketPath !== "string" || !isAbsolute(socketPath) || socketPath.length > 100 || socketPath.includes("\0")) {
    throw new BrokerProtocolError();
  }

  try {
    const parentPath = dirname(socketPath);
    const parent = await lstat(parentPath);
    const socket = await lstat(socketPath);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !socket.isSocket() || socket.isSymbolicLink()) {
      throw new BrokerProtocolError();
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && (parent.uid !== uid || socket.uid !== uid)) throw new BrokerProtocolError();
    if ((parent.mode & 0o077) !== 0 || (socket.mode & 0o022) !== 0) throw new BrokerProtocolError();
    const currentParent = await lstat(parentPath);
    const currentSocket = await lstat(socketPath);
    if (!currentParent.isDirectory() || currentParent.isSymbolicLink()
      || currentParent.dev !== parent.dev || currentParent.ino !== parent.ino
      || !currentSocket.isSocket() || currentSocket.isSymbolicLink()
      || currentSocket.dev !== socket.dev || currentSocket.ino !== socket.ino) {
      throw new BrokerProtocolError();
    }
  } catch {
    throw new BrokerProtocolError();
  }
}

function parseResponse(bytes) {
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw new BrokerProtocolError();
  }
  if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) throw new BrokerProtocolError();
  try {
    const value = JSON.parse(text.slice(0, -1));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new BrokerProtocolError();
    return value;
  } catch {
    throw new BrokerProtocolError();
  }
}

export async function requestBroker(socketPath, operation, options = {}) {
  if (!OPERATIONS.has(operation)) throw new BrokerProtocolError();
  await (options.validateSocketPath ?? validatePrivateSocketPath)(socketPath);
  const request = Buffer.from(`${JSON.stringify({ version: 1, operation })}\n`, "utf8");
  if (request.byteLength > MAX_REQUEST_BYTES) throw new BrokerProtocolError();

  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    const bytes = Buffer.alloc(MAX_RESPONSE_BYTES);
    let size = 0;
    let deadline;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket?.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    deadline = setTimeout(() => finish(new BrokerProtocolError()), options.timeoutMs ?? BROKER_TIMEOUT_MS);
    try {
      socket = (options.connect ?? connect)({ path: socketPath });
    } catch {
      finish(new BrokerProtocolError());
      return;
    }

    socket.setTimeout(options.timeoutMs ?? BROKER_TIMEOUT_MS);
    socket.on("timeout", () => finish(new BrokerProtocolError()));
    socket.on("error", () => finish(new BrokerProtocolError()));
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk) => {
      if (settled) return;
      if (size + chunk.byteLength > MAX_RESPONSE_BYTES) {
        finish(new BrokerProtocolError());
        return;
      }
      chunk.copy(bytes, size);
      size += chunk.byteLength;
      const firstNewline = bytes.subarray(0, size).indexOf(0x0a);
      if (firstNewline !== -1 && firstNewline !== size - 1) {
        finish(new BrokerProtocolError());
      }
    });
    socket.on("end", () => {
      try {
        const response = parseResponse(bytes.subarray(0, size));
        finish(null, response);
      } catch {
        finish(new BrokerProtocolError());
      }
    });
    socket.on("close", () => {
      if (!settled) finish(new BrokerProtocolError());
    });
  });
}
