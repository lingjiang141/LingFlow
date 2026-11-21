import test from "node:test";
import assert from "node:assert/strict";
import { specBoard, ticketColumns } from "../ui/spec-board.js";

const ticket = (id, digest, projectId = "a", state = "queued", risk = "medium") => ({
  id, projectId, state, risk, ...(digest ? { sources: { spec: { file: "spec.md", digest } } } : {}),
});

test("the board follows the latest registered spec and groups batches of the same frozen version", () => {
  const tasks = [ticket("old", "v1"), ticket("other-project", "v3", "b"), ticket("new-1", "v2", "a", "accepted", "low"), ticket("legacy"), ticket("new-2", "v2", "a", "reviewing", "high")];
  tasks[0].sources.spec.file = 'previous/spec.md';
  const board = specBoard(tasks, "a");
  assert.deepEqual(board.specs.map(({ digest }) => digest), ["v2", "v1"]);
  assert.deepEqual(board.tasks.map(({ id, state, risk }) => [id, state, risk]), [["new-1", "accepted", "low"], ["new-2", "reviewing", "high"]]);
  assert.deepEqual(specBoard(tasks, "a", board.specs[1].key).tasks.map(({ id }) => id), ["old"]);
  assert.deepEqual(specBoard(tasks, "a", "all").tasks.map(({ id }) => id), ["old", "new-1", "legacy", "new-2"]);
});

test("legacy tasks stay visible when the project has no registered spec", () => {
  const tasks = [ticket("legacy"), ticket("other-project", "v1", "b")];
  const board = specBoard(tasks, "a");
  assert.equal(board.current, undefined);
  assert.deepEqual(board.tasks, [tasks[0]]);
});

test("released tickets leave the active columns and follow delivered tickets as history", () => {
  const tasks = [
    { id: "released-pause", state: "paused", releasedScope: { reason: "保留历史" } },
    { id: "abandoned", state: "abandoned" },
    { id: "paused", state: "paused" },
    { id: "released-review", state: "reviewing", scopeReleased: true },
    { id: "reviewing", state: "reviewing" },
    { id: "trial", state: "trial" },
    { id: "superseded", state: "superseded" },
  ];
  const columns = ticketColumns(tasks);
  assert.deepEqual(columns.map(column => column.tasks.map(({ id }) => id)), [
    ["paused"], ["reviewing"], ["trial", "released-pause", "released-review", "superseded", "abandoned"],
  ]);
  assert.equal(columns[2].historyCount, 4);
});

test("a Spec cycle shows its original five tickets and all three additions across frozen revisions", () => {
  const tasks = [ticket('previous', 'old')];
  tasks[0].sources.spec.file = 'previous/spec.md';
  tasks.push(...Array.from({length:8},(_,i)=>({...ticket(String(i+1),i<5?'v1':i<7?'v2':'v3'),
    requirementId:'approved-round',state:i<5?'accepted':'queued'})));
  tasks.push({...ticket('unrelated','foreign'),sources:{spec:{file:'other/spec.md',digest:'foreign'}}});
  const board=specBoard(tasks,'a',JSON.stringify(['cycle','spec.md']));
  assert.equal(board.tasks.length,8);
  assert.equal(board.selected.kind,'cycle');
  assert.equal(board.selected.versions.length,3);
  assert.equal(specBoard(tasks.slice(0,-1),'a').tasks.length,8);
  assert.equal(specBoard(tasks,'a',JSON.stringify(['spec.md','v2'])).tasks.length,2);
  assert.equal(tasks[1].sources.spec.digest,'v1','The frozen source remains unchanged');
});
