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

test("pet puts abandoned tickets below released scopes and excludes them from progress", () => {
  const entries = [[2,'abandoned'],[12,'assigned'],[3,'reviewing'],[10,'assigned'],[4,'rework'],
    [22,'trial'],[21,'trial'],[1,'accepted'],[5,'ready'],[0,'superseded'],[6,'abandoned'],[8,'queued'],[7,'queued'],[20,'paused']];
  const tasks=entries.map(([number,state])=>({id:String(number),ticketKey:'R36-'+number,projectId:'p',title:state,state,
    ...([6,20].includes(number)&&{releasedScope:{reason:'retired'}}),sources:{spec:{file:'spec.md',digest:'v1'}}}));
  const snapshot={projects:[{id:'p',name:'Project'}],tasks};
  const view=petProgress(snapshot,{projectId:'p'});
  const ids=group=>view.groups.find(g=>g.id===group).tickets.map(t=>Number(t.id));
  assert.deepEqual(ids('active'),[10,12,3,4]);
  assert.deepEqual(ids('closed'),[21,22,1,5,0,20,2,6]);
  assert.deepEqual(ids('waiting'),[7,8]);
  assert.deepEqual(view.groups[0].tickets.slice(-3).map(ticket=>ticket.label),['范围已释放','已放弃','已放弃']);
  assert.deepEqual([view.total,view.completed,view.accepted,view.percent],[10,4,1,40]);
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

test("every enabled character has verified offline and normalized assets", async () => {
  const assets = createPetAssets(".validation/pet-cache-test");
  assert.deepEqual(assets.catalog.characters.map(character => character.id), ["dsh", "claude", "gpt", "gemini", "grok"]);
  assert.equal(assets.catalog.characters.reduce((count, character) => count + character.animations.length, 0), 539);
  for (const character of assets.catalog.characters) {
    assert.ok(character.referenceHeight > 0);
    for (const anim of character.animations) {
      const result = await assets.image(character.id, anim.id);
      assert.equal(result.bytes.length, result.animation.size);
      assert.ok(result.animation.frameCount > 0 && result.animation.fps > 0);
    }
  }
  await assert.rejects(assets.image("../", "unknown"), /未知/);
});

test("pet counts dispatched progress separately and places planned tickets into waiting", () => {
  const tasks = [
    { id: "1", projectId: "p", ticketKey: "R35-01", state: "accepted", title: "已验收票", sources: { spec: { file: "spec.md", digest: "v1" } } },
    { id: "2", projectId: "p", ticketKey: "R35-02", state: "assigned", title: "开发中票", sources: { spec: { file: "spec.md", digest: "v1" } } },
  ];
  const plannedTickets = [
    { key: "R35-03", projectId: "p", requirementId: "req1", title: "待派发规划票", risk: "medium", dependsOn: ["R35-02"], specSource: { file: "spec.md", digest: "v1" }, requirementClosed: false },
    { key: "R35-04", projectId: "p", requirementId: "req2", title: "遗留收口规划票", risk: "low", dependsOn: [], specSource: { file: "spec.md", digest: "v1" }, requirementClosed: true },
  ];
  const view = petProgress({ projects: [{ id: "p", name: "项目" }], tasks, plannedTickets }, { projectId: "p", specKey: "current" });
  assert.equal(view.total, 2);
  assert.equal(view.completed, 1);
  assert.equal(view.accepted, 1);
  assert.equal(view.percent, 50);
  assert.equal(view.plannedCount, 2);
  const waiting = view.groups.find(g => g.id === "waiting").tickets;
  assert.equal(waiting.length, 2);
  assert.deepEqual(waiting.map(t => [t.key, t.state, t.label, t.planned]), [
    ["R35-03", "planned", "已规划 · 待派发", true],
    ["R35-04", "planned", "该需求已收口 · 未派发", true],
  ]);
});
