import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { once } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { startServer } from "../src/server.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, options) {
  mkdirSync(".validation", { recursive: true });
  const app = await startServer({ dataDir: mkdtempSync(path.resolve(".validation", "shutdown-")), port: 0, ...options });
  t.after(() => app.close());
  return app;
}

test("shutdown releases an HTTP client that never finishes uploading", async t => {
  const app = await fixture(t);
  const socket = connect(app.port, "127.0.0.1");
  t.after(() => socket.destroy());
  await once(socket, "connect");
  const received = once(app.server, "request");
  socket.write(`POST /api/ui/snapshot HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\nAuthorization: Bearer ${app.uiToken}\r\nContent-Length: 1000\r\n\r\n{`);
  await received;
  const started = performance.now();
  // Cleanup also makes the old indefinitely-blocking implementation fail fast.
  const rescue = setTimeout(() => socket.destroy(), 2200);
  try {
    await app.close();
    assert.ok(performance.now() - started < 1900, "Exit must not wait indefinitely for a request body");
  } finally { clearTimeout(rescue); }
});

test("shutdown finishes accepted work before closing workflow storage", async t => {
  const app = await fixture(t);
  const original = app.workflow.call;
  let accept;
  const accepted = new Promise(resolve => { accept = resolve; });
  let finish;
  const blocked = new Promise(resolve => { finish = resolve; });
  t.after(() => finish());
  let stored;
  app.workflow.call = async (...args) => {
    accept();
    await blocked;
    stored = await original(...args);
    return stored;
  };
  const response = fetch(`http://127.0.0.1:${app.port}/api/ui/call`, {
    method: "POST", headers: { Authorization: `Bearer ${app.uiToken}` },
    body: JSON.stringify({ command: "createProject", args: { name: "Shutdown", root: process.cwd() }, operationId: "shutdown-create" }),
  }).then(res => res.json()).catch(() => null);
  await accepted;
  const closed = app.close();
  assert.equal(app.close(), closed, "Concurrent quit requests share one shutdown");
  let finished = false;
  void closed.then(() => { finished = true; });
  await delay(1300);
  assert.equal(finished, false, "A socket deadline must not cancel accepted mutations");
  finish();
  await closed;
  await response;
  assert.equal(stored.name, "Shutdown");
});
