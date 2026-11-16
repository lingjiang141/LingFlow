import test from 'node:test';
import assert from 'node:assert/strict';
import { installTools } from '../adapters/dsh/tool-registration.mjs';
import { createToolWatchdog } from '../adapters/dsh/tool-watchdog.mjs';
import { createRelay } from '../adapters/dsh/relay.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { setImmediate as turn } from 'node:timers/promises';
import { apply } from '../adapters/dsh/index.mjs';
import { startServer } from '../src/server.mjs';
import path from 'node:path';
import { fixture } from './helpers/evidence-fixture.mjs';

function host() {
  const live = new Map(), saved = new Map(), cleanup = [], events = [];
  const make = id => {
    const registry = new Map();
    const agent = { id, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session: { snapshotEvents: () => [] }, registry };
    agent.ctx = { tools: { get(name, scope) { assert.equal(scope, agent); return registry.get(name); }, register(def) {
      if (agent.fail) throw Error('host registration unavailable');
      registry.set(def.name, def); events.push({ id, name: def.name, type: 'add' });
      return () => { if (registry.get(def.name) === def) { registry.delete(def.name); events.push({ id, name: def.name, type: 'remove' }); } };
    } } };
    saved.set(id, agent);
    return agent;
  };
  const ctx = { effect(fn) { cleanup.push(fn()); }, agents: { list: () => [...live.values()], get: id => live.get(id) },
    sessionController: { async resolveAgent(id) { const agent = saved.get(id); live.set(id, agent); return { agent }; } } };
  return { ctx, make, saved, live, events, dispose() { for (const fn of cleanup.splice(0).reverse()) fn?.(); } };
}

test('reload repairs all four sleeping bound members, then repairs a restored preset before delivery', async () => {
  const h = host(), definitions = [{ name: 'lingflow_connect' }, { name: 'lingflow_team' }];
  for (let n = 1; n <= 4; n++) h.make('member-' + n);
  const build = () => createToolWatchdog({ ctx: h.ctx, definitions, bindings: async () => [...h.saved.keys()] });
  let watchdog = build();
  await watchdog.sweep();
  assert.equal(h.live.size, 4);
  watchdog.dispose(); h.dispose(); h.live.clear();
  watchdog = build();
  await watchdog.sweep();
  for (const agent of h.saved.values()) assert.equal(agent.registry.size, 2);
  const agent = h.saved.get('member-2');
  // Host restoration rebuilds its registry without emitting agent/created.
  agent.registry.clear();
  mkdirSync('.validation', { recursive: true });
  let prompts = 0, acks = 0;
  const relay = createRelay({ file: path.join(mkdtempSync('.validation/tool-relay-'), 'ledger.json'), agents: h.ctx.agents,
    activeJobs: () => 0, ensureTools: agent => watchdog.ensure(agent),
    controller: { async prompt() { assert.equal(agent.registry.size, 2); prompts++; return { accepted: true }; } },
    api: async action => { if (action === 'ack') acks++; return { valid: true }; } });
  await relay.accept([{ id: 'wake', sessionId: agent.id, text: 'work' }]);
  assert.equal(prompts, 1); assert.equal(acks, 1);
  agent.registry.clear();
  await watchdog.sweep();
  assert.equal(agent.registry.size, 2);
  const sent = watchdog.repairs(); watchdog.acknowledge(sent);
  assert.ok(watchdog.history().some(event => event.sessionId === agent.id && event.ok));
  for (const member of h.saved.values()) for (const definition of definitions) {
    const events = h.events.filter(event => event.id === member.id && event.name === definition.name);
    assert.equal(events.at(-1).type, 'add');
  }
  watchdog.dispose(); h.dispose();
});

test('failed reinstall blocks prompt and ACK and exposes both missing tools and failure history', async () => {
  const h = host(), agent = h.make('broken'); h.live.set(agent.id, agent); agent.fail = true;
  const watchdog = createToolWatchdog({ ctx: h.ctx, definitions: [{ name: 'lingflow_team' }, { name: 'lingflow_connect' }], bindings: async () => [agent.id] });
  await watchdog.sweep();
  let requests = 0;
  const relay = createRelay({ file: path.join(mkdtempSync('.validation/tool-failed-'), 'ledger.json'), agents: h.ctx.agents,
    ensureTools: agent => watchdog.ensure(agent), controller: { prompt() { requests++; } }, api() { requests++; } });
  await relay.accept([{ id: 'blocked-wake', sessionId: agent.id, text: 'work' }]);
  assert.equal(requests, 0);
  assert.equal(relay.diagnostics()[0].reason, 'bridge-tools-missing');
  assert.equal(watchdog.statuses()[0].toolsMissing.length, 2);
  assert.equal(watchdog.history().at(-1).ok, false);
  watchdog.dispose(); h.dispose();
});

test('a preset reset during prompt acceptance withholds ACK and recovery never duplicates the prompt', async () => {
  const h = host(), agent = h.make('restoring'); h.live.set(agent.id, agent);
  let available = true, prompts = 0, acks = 0;
  const relay = createRelay({ file: path.join(mkdtempSync('.validation/tool-race-'), 'ledger.json'), agents: h.ctx.agents,
    activeJobs: () => 0, ensureTools: () => available,
    controller: { async prompt() { prompts++; available = false; return { accepted: true }; } },
    api: async action => { if (action === 'ack') acks++; return { valid: true }; } });
  const wakes = [{ id: 'same-wake', sessionId: agent.id, text: 'work' }];
  await relay.accept(wakes);
  assert.equal(prompts, 1); assert.equal(acks, 0);
  assert.equal(relay.diagnostics().at(-1).reason, 'bridge-tools-missing');
  await relay.accept(wakes);
  assert.equal(prompts, 1); assert.equal(acks, 0);
  available = true;
  await relay.accept(wakes);
  assert.equal(prompts, 1); assert.equal(acks, 1);
});

test('heartbeat persists reinstall evidence and blocks existing delivered task, then clears after repair', async t => {
  const f = await fixture(t);
  const dev = f.store.read().roles.find(role => role.kind === 'developer');
  const task = f.store.read().tasks[0];
  const missing = { id: dev.sessionId, state: 'idle', pending: 0, jobs: 0, toolsMissing: ['lingflow_team'],
    toolsReinstall: { id: 'repair-failure', ok: false, at: Date.now() } };
  const response = f.wf.heartbeat([missing]);
  assert.equal(response.deliveries.some(wake => wake.sessionId === dev.sessionId), false);
  assert.ok(f.wf.bridgeBindings().sessions.includes(dev.sessionId));
  assert.equal(f.wf.snapshot().tasks.find(item => item.id === task.id).blockedBy[0].code, 'bridge-tools-missing');
  const pending = f.store.read().wakes.find(wake => wake.roleId === dev.id && wake.state !== 'consumed');
  if (pending) {
    assert.equal(f.wf.validWake(pending.id, dev.sessionId).valid, false);
    assert.throws(() => f.wf.acknowledge(pending.id, dev.sessionId), /bridge-tools-missing/);
  }
  const events = f.store.db.prepare("SELECT data FROM events WHERE kind='tools-reinstall'").all();
  assert.equal(events.length, 1); assert.equal(JSON.parse(events[0].data).ok, false);
  f.wf.heartbeat([missing]);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='tools-reinstall'").get().n, 1);
  f.wf.heartbeat([{ ...missing, toolsMissing: [], toolsReinstall: { id: 'repair-success', ok: true, at: Date.now() } }]);
  assert.equal(f.wf.snapshot().tasks.find(item => item.id === task.id).blockedBy, undefined);
});

test('a lost registry entry is repaired despite an unchanged installation marker', () => {
  const registry = new Map(), disposers = [];
  const agent = { ctx: { tools: { get: name => registry.get(name), register(def) {
    registry.set(def.name, def);
    return () => { if (registry.get(def.name) === def) registry.delete(def.name); };
  } } } };
  const definitions = [{ name: 'lingflow_team' }, { name: 'lingflow_connect' }];
  const effect = setup => disposers.push(setup());
  installTools(agent, definitions, effect);
  registry.delete('lingflow_team');
  installTools(agent, definitions, effect);
  assert.ok(registry.has('lingflow_team'), 'tool must be resolvable after watchdog reinstall');
  for (const dispose of disposers.reverse()) dispose();
  assert.equal(registry.size, 0);
});

test('actual plugin apply includes sleeping bindings and heartbeat/status publish failure and repair history', async t => {
  const h = host(), handlers = new Map(), requests = [];
  h.ctx.on = (name, fn) => handlers.set(name, fn);
  h.ctx.logger = () => ({ warn() {} });
  h.ctx.sessionController.prompt = async () => { assert.fail('must not deliver while tools are missing'); };
  for (let i = 0; i < 4; i++) h.make('sleeping-' + i);
  const dataDir = mkdtempSync(path.resolve('.validation', 'plugin-tools-'));
  const toolsModule = path.join(dataDir, 'definitions.mjs');
  writeFileSync(toolsModule, 'export const defineTool = definition => definition;');
  writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: 1, bridgeToken: 'fixture' }));
  let lastSessions;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, body });
    if (url.endsWith('/bindings')) return Response.json({ sessions: [...h.saved.keys()] });
    if (url.endsWith('/heartbeat')) { lastSessions = body.sessions; return Response.json({ deliveries: [{ id: 'wake', sessionId: 'sleeping-0', text: 'task' }] }); }
    if (url.endsWith('/policy')) return Response.json({ timeoutMs: 1000 });
    return Response.json({ ok: true });
  });
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => h.dispose());
  await apply(h.ctx, { dataDir, toolsModule });
  for (const agent of h.saved.values()) {
    const result = await agent.registry.get('lingflow_team').execute({ command: 'list' }, { agent });
    assert.equal(result.ok, true);
  }
  const agent = h.saved.get('sleeping-0');
  agent.registry.clear();
  let next = false;
  handlers.get('agent/pre-step')({ agent }, () => { next = true; });
  assert.equal(next, true); assert.equal(agent.registry.size, 2);
  agent.registry.clear(); agent.fail = true;
  t.mock.timers.tick(2000); await turn(); await turn();
  assert.equal(lastSessions.length, 4);
  assert.equal(lastSessions.find(session => session.id === agent.id).toolsMissing.length, 2);
  assert.equal(requests.filter(request => request.url.endsWith('/ack')).length, 0);
  const health = JSON.parse(readFileSync(path.join(dataDir, 'dsh-status.json')));
  assert.equal(health.sessions.find(session => session.sessionId === agent.id).toolsMissing.length, 2);
  assert.ok(health.toolsReinstalls.some(event => event.sessionId === agent.id && !event.ok));
  agent.fail = false;
  handlers.get('agent/status')({ agent });
  assert.equal(agent.registry.size, 2);
});

test('registrations in a shared tools service remain isolated by agent scope', () => {
  const maps = new Map([['one', new Map()], ['two', new Map()]]), cleanup = [];
  const shared = { [Symbol.for('lingflow.tools.installations')]: new Map(), get(name, agent) { return maps.get(agent.id).get(name); } };
  for (const id of ['one', 'two', 'one']) {
    const tools = Object.create(shared);
    tools.register = def => { maps.get(id).set(def.name, def); return () => maps.get(id).delete(def.name); };
    installTools({ id, ctx: { tools } }, [{ name: 'lingflow_team' }], fn => cleanup.push(fn()));
  }
  assert.ok(maps.get('one').has('lingflow_team'));
  assert.ok(maps.get('two').has('lingflow_team'));
  cleanup.reverse().forEach(fn => fn());
});

test('authenticated bindings endpoint includes persisted disabled members and heartbeat surfaces tool blockers over HTTP', async t => {
  const f = await fixture(t);
  const ids = f.store.read().roles.map(role => role.sessionId);
  f.close();
  const app = await startServer({ dataDir: f.dir, port: 0 });
  t.after(() => app.close());
  const config = JSON.parse(readFileSync(path.join(f.dir, 'config.json')));
  const post = (route, body, token) => fetch(`http://127.0.0.1:${app.port}/api/bridge/${route}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  assert.equal((await post('bindings', {}, 'wrong')).status, 401);
  const response = await post('bindings', {}, config.bridgeToken);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).sessions.sort(), ids.sort());
  const heartbeat = await post('heartbeat', { sessions: [{ id: 'Dev', state: 'idle', pending: 0, jobs: 0,
    toolsMissing: ['lingflow_team'], toolsReinstall: { id: 'http-repair', ok: false, at: Date.now() } }] }, config.bridgeToken);
  assert.equal(heartbeat.status, 200);
  const snapshot = await app.workflow.snapshot();
  assert.equal(snapshot.tasks.find(task => task.id === f.taskId).blockedBy[0].code, 'bridge-tools-missing');
});
