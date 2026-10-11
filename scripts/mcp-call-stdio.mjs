#!/usr/bin/env node
// Normal public MCP stdio client for a fresh installed bridge process. This is
// useful during rolling upgrades; it never accesses an extension socket, page
// credentials or private protocol and never restarts the shared HTTP bridge.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new Error("MCP request exceeds 2 MiB");
}
const request = JSON.parse(input);
if (!request || !["tools/list", "tools/call"].includes(request.method)) {
  throw new Error("Only public tools/list and tools/call requests are accepted");
}
const child = spawn(process.execPath, [fileURLToPath(new URL("../bridge.mjs", import.meta.url))], {
  stdio: ["pipe", "pipe", "pipe"], env: process.env,
});
const readers = readline.createInterface({ input: child.stdout });
const pending = new Map();
let finished = false;
let responseBytes = 0;
const deadline = setTimeout(() => {
  for (const item of pending.values()) item.reject(new Error("MCP stdio request timed out; reconcile any operation ID before retrying"));
  child.kill("SIGTERM");
}, 55_000);
const exited = new Promise((resolve) => child.once("exit", (code, signal) => {
  resolve({ code, signal });
  if (!finished) for (const item of pending.values()) item.reject(new Error("MCP bridge exited before its response"));
}));
child.stderr.on("data", () => { /* Child diagnostics can include private context; don't echo them. */ });
child.on("error", (error) => { for (const item of pending.values()) item.reject(error); });
readers.on("line", (line) => {
  responseBytes += Buffer.byteLength(line);
  if (responseBytes > 4 * 1024 * 1024) {
    for (const item of pending.values()) item.reject(new Error("MCP response exceeds 4 MiB"));
    child.kill("SIGTERM");
    return;
  }
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (pending.has(message.id)) {
    const item = pending.get(message.id);
    pending.delete(message.id);
    item.resolve(message);
  }
});
const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
const rpc = (message) => new Promise((resolve, reject) => {
  pending.set(message.id, { resolve, reject });
  send(message);
});
try {
  const initialized = await rpc({
    jsonrpc: "2.0", id: "stdio-client-initialize", method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "mdb-public-stdio-client", version: "1.0.0" } },
  });
  if (initialized.error) throw new Error("MCP initialization failed");
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const response = await rpc({ ...request, jsonrpc: "2.0", id: "stdio-client-request" });
  finished = true;
  process.stdout.write(JSON.stringify(response) + "\n");
  child.stdin.end();
  await exited;
  if (response.error || response.result?.isError) process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  readers.close();
  if (!finished) child.kill("SIGTERM");
}
