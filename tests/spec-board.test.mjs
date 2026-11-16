import test from "node:test";
import assert from "node:assert/strict";
import { specBoard } from "../ui/spec-board.js";

const ticket = (id, digest, projectId = "a", state = "queued", risk = "medium") => ({
  id, projectId, state, risk, ...(digest ? { sources: { spec: { file: "spec.md", digest } } } : {}),
});

test("the board follows the latest registered spec and groups batches of the same frozen version", () => {
  const tasks = [ticket("old", "v1"), ticket("other-project", "v3", "b"), ticket("new-1", "v2", "a", "accepted", "low"), ticket("legacy"), ticket("new-2", "v2", "a", "reviewing", "high")];
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
