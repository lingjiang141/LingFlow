import assert from "node:assert/strict";
import test from "node:test";
import { coversPath, overlaps } from "../src/files.mjs";
import { assertOutsideScope, scopeBaseline } from "../src/quality.mjs";
import { fixture } from "./helpers/evidence-fixture.mjs";

test("legacy history cannot inject a non-path into either ownership gate", async t => {
  const f = await fixture(t);
  const s = f.store.read(), task = s.tasks[0];
  const peer = { ...task, id: "legacy-peer", ticketKey: "OLD-01", state: "trial", writes: ["current.txt"] };
  task.concurrentPeers = [peer.id];
  s.tasks.push(peer);
  f.put("prior.txt", "owned by a historical write");
  const git = f.wf.ownershipGit(s, task);
  for (const legacy of [
    { previous: { baseline: task.baseline } },
    { previous: { state: "assigned", deliveredAt: 1, deliveryIssue: null } },
    { previous: {} },
    {},
  ]) {
    peer.scheduleHistory = [legacy, { previous: { writes: ["prior.txt"] } }];
    const writes = f.wf.foreignWrites(s, task);
    assert.deepEqual(writes, ["current.txt", "prior.txt"]);
    assert.doesNotThrow(() => assertOutsideScope(f.root, task, writes, git));
    assert.equal(scopeBaseline(f.root, task, writes, git).other.some(([file]) => file === "prior.txt"), false);
  }
  peer.scheduleHistory = [{ previous: { writes: [undefined] } }];
  assert.throws(() => f.wf.foreignWrites(s, task), { verificationCode: "contract-invalid", message: /OLD-01.*scheduleHistory\[0\].*writes\[0\]/ });
});

test("path helpers report malformed entries with field and index even after a match", () => {
  assert.throws(() => coversPath(["valid", undefined], "valid"), { verificationCode: "contract-invalid", message: /paths\[1\].*undefined/ });
  assert.throws(() => coversPath([], undefined), { verificationCode: "contract-invalid", message: /file.*undefined/ });
  assert.throws(() => overlaps(["valid"], ["valid", 7]), { verificationCode: "contract-invalid", message: /b\[1\].*number/ });
});
