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
  const snapshot = { projects: [{ id: "p", name: "项目" }], tasks: [{ ...tasks[0], id: "old", sources: { spec: { file: "previous/spec.md", digest: "v1" } } }, ...tasks] };
  const view = petProgress(snapshot, { projectId: "p", specKey: "current" });
  assert.equal(view.total, 7); assert.equal(view.completed, 3); assert.equal(view.accepted, 1); assert.equal(view.percent, 43);
  assert.deepEqual(view.groups.map(group => [group.id, group.tickets.length]), [["closed", 4], ["active", 2], ["waiting", 2]]);
  assert.equal(petProgress(snapshot, { projectId: "p", specKey: JSON.stringify(["previous/spec.md", "v1"]) }).total, 1);
  assert.equal(petProgress({ projects: [], tasks: [] }).spec, null);
  const unregistered = petProgress({ projects: snapshot.projects, tasks: [{ ...tasks[0], sources: undefined }] });
  assert.equal(unregistered.total, 0, "Unregistered legacy tasks must not masquerade as the current Spec");
  assert.equal(petProgress({projects:snapshot.projects,tasks:[{...tasks[0],sources:undefined}]},
    {projectId:'p',specKey:'all'}).total,1,"Only the explicit whole-project view includes unregistered tasks");
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

test("pet puts live development and trials first, then ticket numbers, with abandoned and historical tickets last", () => {
  const entries = [[2,'abandoned'],[12,'assigned'],[3,'reviewing'],[10,'assigned'],[4,'rework'],
    [22,'trial'],[21,'trial'],[1,'accepted'],[5,'ready'],[0,'superseded'],[6,'abandoned'],[8,'queued'],[7,'queued']];
  const tasks=entries.map(([number,state])=>({id:String(number),ticketKey:'R36-'+number,projectId:'p',title:state,state,
    ...(number===6&&{releasedScope:{reason:'retired'}}),sources:{spec:{file:'spec.md',digest:'v1'}}}));
  const snapshot={projects:[{id:'p',name:'Project'}],tasks};
  const view=petProgress(snapshot,{projectId:'p'});
  const ids=group=>view.groups.find(g=>g.id===group).tickets.map(t=>Number(t.id));
  assert.deepEqual(ids('active'),[10,12,3,4,2]);
  assert.deepEqual(ids('closed'),[21,22,1,5,0,6]);
  assert.deepEqual(ids('waiting'),[7,8]);
  assert.equal(view.total,11);assert.equal(view.completed,4);assert.equal(view.accepted,1);
  assert.deepEqual(tasks.map(t=>Number(t.id)),entries.map(([number])=>number),'Sorting does not reorder stored tasks');
});

test("pet defaults to the whole Spec cycle and can switch back to one frozen revision", () => {
  const tasks=Array.from({length:8},(_,i)=>({id:String(i),projectId:'p',ticketKey:'R36-'+(i+1),
    state:i<5?'accepted':'assigned',title:'Ticket '+i,sources:{spec:{file:'round/spec.md',digest:i<5?'v1':i<7?'v2':'v3'}}}));
  tasks.unshift({...tasks[0],id:'old',sources:{spec:{file:'previous/spec.md',digest:'old'}}});
  const snapshot={projects:[{id:'p',name:'Project'}],tasks};
  const view=petProgress(snapshot,{projectId:'p',specKey:'current'});
  assert.equal(view.total,8);assert.equal(view.completed,5);assert.equal(view.percent,63);
  assert.equal(view.spec.kind,'cycle');assert.equal(view.cycles.length,2);
  assert.equal(petProgress(snapshot,{projectId:'p',specKey:JSON.stringify(['round/spec.md','v2'])}).total,2);
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
