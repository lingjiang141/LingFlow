import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { petProgress } from "../ui/pet-model.js";
import { chooseIdle, playbackFrame } from "../desktop/pet/animation-policy.js";
import { subjectBounds } from "../desktop/pet/subject-scale.js";
const require = createRequire(import.meta.url);
const { fitBounds, aroundCenter } = require("../desktop/pet-geometry.cjs");
const { createPetAssets } = require("../desktop/pet-assets.cjs");

test("pet follows selected spec, keeps clockwise buckets and excludes retired tickets from progress", () => {
  const tasks = ["accepted", "ready", "trial", "assigned", "reviewing", "queued", "paused", "superseded"].map((state, index) => ({
    id: String(index), projectId: "p", ticketKey: "R-" + index, state, title: state, description: "票面概述",
    sources: { spec: { file: "spec.md", digest: "v2" } },
  }));
  const snapshot = { projects: [{ id: "p", name: "项目" }], tasks: [{ ...tasks[0], id: "old", sources: { spec: { file: "spec.md", digest: "v1" } } }, ...tasks] };
  const view = petProgress(snapshot, { projectId: "p", specKey: "current" });
  assert.equal(view.total, 7); assert.equal(view.completed, 3); assert.equal(view.accepted, 1); assert.equal(view.percent, 43);
  assert.deepEqual(view.groups.map(group => [group.id, group.tickets.length]), [["closed", 4], ["active", 2], ["waiting", 2]]);
  assert.equal(petProgress(snapshot, { projectId: "p", specKey: JSON.stringify(["spec.md", "v1"]) }).total, 1);
  assert.equal(petProgress({ projects: [], tasks: [] }).spec, null);
  const unregistered = petProgress({ projects: snapshot.projects, tasks: [{ ...tasks[0], sources: undefined }] });
  assert.equal(unregistered.total, 0, "Unregistered legacy tasks must not masquerade as the current Spec");
});

test("each idle action completes exactly two loops; viewing loops coding continuously", () => {
  const animation = { frameCount: 120, fps: 12 };
  assert.deepEqual(playbackFrame(animation, 9999, false), { frame: 119, loops: 0, finished: false });
  assert.deepEqual(playbackFrame(animation, 10000, false), { frame: 0, loops: 1, finished: false });
  assert.deepEqual(playbackFrame(animation, 20000, false), { frame: 119, loops: 2, finished: true });
  assert.deepEqual(playbackFrame(animation, 20000, true), { frame: 0, loops: 2, finished: false });
  const { catalog } = createPetAssets(".validation/pet-cache-test");
  for (const character of catalog.characters) {
    for (const value of [0, .2, .5, .9, .999999]) {
      const action = chooseIdle(character, character.idle, () => value);
      assert.notEqual(action.id, character.coding); assert.notEqual(action.id, character.idle);
    }
  }
});

test("subject scale ignores isolated effects and tracks the character rather than the full frame", () => {
  const pixels = new Uint8ClampedArray(100 * 100 * 4);
  for (let y = 20; y < 80; y++) for (let x = 40; x < 60; x++) pixels[(y * 100 + x) * 4 + 3] = 255;
  const before = subjectBounds(pixels, 100, 100, 100, 1, 1);
  for (let x = 0; x < 100; x++) pixels[x * 4 + 3] = 90;
  pixels[3] = 255;
  const after = subjectBounds(pixels, 100, 100, 100, 1, 1);
  assert.ok(Math.abs(before.height - after.height) <= 1);
  assert.equal(before.centerX, after.centerX);
});

test("pet stays reachable at display edges and after a monitor disappears", () => {
  const area = { x: -1920, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(fitBounds({ x: -3000, y: 1000, width: 184, height: 184 }, area), { x: -1920, y: 856, width: 184, height: 184 });
  const expanded = aroundCenter({ x: -184, y: 800, width: 184, height: 184 }, 760, 640, area);
  assert.equal(expanded.x, -760); assert.equal(expanded.y, 400);
  assert.deepEqual(fitBounds({ x: 10000, y: 10000, width: 760, height: 640 }, { x: 0, y: 0, width: 640, height: 480 }), { x: 0, y: 0, width: 640, height: 480 });
});

test("every enabled character has verified bundled idle and coding assets", async () => {
  const assets = createPetAssets(".validation/pet-cache-test");
  assert.deepEqual(assets.catalog.characters.map(character => character.id), ["dsh", "claude", "gpt", "gemini", "grok"]);
  assert.equal(assets.catalog.characters.reduce((count, character) => count + character.animations.length, 0), 565);
  for (const character of assets.catalog.characters) for (const id of [character.coding, character.idle]) {
    const result = await assets.image(character.id, id);
    assert.equal(result.bytes.length, result.animation.size);
    assert.ok(result.animation.frameCount > 0 && result.animation.fps > 0);
  }
  await assert.rejects(assets.image("../", "unknown"), /未知/);
});
