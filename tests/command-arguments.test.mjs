import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/evidence-fixture.mjs';
import { parseCommandArgs, parseCommandRequest, requiredArguments, commandExamples } from '../src/command-arguments.mjs';
import { apply } from '../adapters/dsh/index.mjs';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.mjs';

test('missing inspect taskId is distinct from a nonexistent record and valid inspect still works', async t => {
  const f = await fixture(t);
  const missing = f.call('Dev', 'inspect', {});
  assert.equal(missing.error, 'missing-argument');
  assert.deepEqual(missing.missing, ['taskId']);
  const absent = f.call('Dev', 'inspect', { taskId: 'wrong-id-123456' });
  assert.equal(absent.error, 'not-found');
  assert.equal(absent.scanned, 1);
  assert.equal(absent.idPrefix, 'wrong-id');
  assert.equal(absent.idLength, 15);
  assert.equal(f.call('Dev', 'inspect', { taskId: f.taskId }).id, f.taskId);
});

test('one parser normalizes strings, plain objects, null and undefined without coercing identifiers', () => {
  const input = { taskId: '  exact-id  ' };
  assert.equal(parseCommandArgs(input), input);
  assert.deepEqual(parseCommandArgs('  {"taskId":"  exact-id  "} '), input);
  for (const raw of [undefined, null, '', '   ']) assert.deepEqual(parseCommandArgs(raw), {});
  assert.deepEqual(parseCommandArgs({ error: 'a legitimate field' }), { error: 'a legitimate field' });
  assert.equal(parseCommandRequest({ command: 'inspect', args: { taskId: 'id', error: 'a legitimate field' } }).error, undefined);
});

test('JSON errors preserve native parser text and at most eighty received characters', () => {
  const raw = '{oops' + 'x'.repeat(100);
  let message;
  try { JSON.parse(raw); } catch (error) { message = error.message; }
  assert.deepEqual(parseCommandArgs(raw), { error: 'invalid-argument-json', message, received: raw.slice(0, 80) });
});

test('all non-object decoded shapes are rejected before business logic', () => {
  for (const [raw, received] of [['[]', 'array'], [[], 'array'], ['2', 'number'], [2, 'number'], ['true', 'boolean'], [true, 'boolean'], ['null', 'null'], ['"text"', 'string'], [new Date(), 'object']]) {
    const result = parseCommandArgs(raw);
    assert.equal(result.error, 'invalid-arguments-shape');
    assert.equal(result.expected, 'object'); assert.equal(result.received, received);
  }
});

test('every command has a presence policy and a one-line example', () => {
  const source = readFileSync(new URL('../src/workflow.mjs', import.meta.url), 'utf8');
  for (const match of source.matchAll(/(?:case|(?<![.\w])command ===) "(\w+)"/g)) assert.ok(Object.hasOwn(requiredArguments, match[1]), match[1]);
  for (const command of Object.keys(requiredArguments)) assert.ok(commandExamples.includes(command + ': '));
  assert.equal(parseCommandRequest({ command: 'enable', args: { roleId: 'id', enabled: false } }).error, undefined);
});

test('missing args never reads the store; malformed JSON and arrays also never reach find', async t => {
  const f = await fixture(t);
  t.mock.method(f.store, 'read', () => { assert.fail('must not read records for invalid arguments'); });
  assert.equal(f.call('Dev', 'inspect').error, 'missing-argument');
  assert.equal(f.call('Dev', 'inspect', '{oops').error, 'invalid-argument-json');
  assert.equal(f.call('Dev', 'inspect', '[]').error, 'invalid-arguments-shape');
  assert.deepEqual(f.call('ui', 'scopePreview', { writes: [] }).missing, ['projectId']);
});

test('member misuse of arguments returns missing-argument; string and object inspect return real task', async t => {
  const f = await fixture(t), definitions = new Map(), cleanup = [], calls = [];
  const toolsModule = path.join(f.dir, 'tool-definition.mjs');
  writeFileSync(toolsModule, 'export const defineTool = value => value;');
  writeFileSync(path.join(f.dir, 'config.json'), JSON.stringify({ port: 1, bridgeToken: 'fixture' }));
  const agent = { id: 'Dev', ctx: { tools: { register(def) { definitions.set(def.name, def); } } } };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/bindings')) return Response.json({ sessions: ['Dev'] });
    if (url.endsWith('/policy')) return Response.json({ timeoutMs: 1000 });
    const body = JSON.parse(options.body); calls.push(body);
    return Response.json(f.wf.call('Dev', body.command, body.args));
  });
  await apply({ agents: { list: () => [agent] }, on() {}, sessionController: {}, effect(fn) { cleanup.push(fn()); } }, { dataDir: f.dir, toolsModule });
  t.after(() => cleanup.reverse().forEach(fn => fn?.()));
  const tool = definitions.get('lingflow_team');
  assert.ok(tool.description.includes('inspect: {"command":"inspect","args":'));
  const missing = await tool.execute({ command: 'inspect', arguments: JSON.stringify({ taskId: f.taskId }) }, { agent });
  assert.equal(missing.error, 'missing-argument'); assert.deepEqual(missing.missing, ['taskId']);
  assert.match(missing.hint, /未知字段 arguments，已忽略/); assert.equal(calls.length, 0);
  for (const args of [{ taskId: f.taskId }, JSON.stringify({ taskId: f.taskId })])
    assert.equal((await tool.execute({ command: 'inspect', args }, { agent })).id, f.taskId);
  assert.equal((await tool.execute({ command: 'inspect', args: '{oops' }, { agent })).error, 'invalid-argument-json');
  assert.equal((await tool.execute({ command: 'inspect', args: '[]' }, { agent })).error, 'invalid-arguments-shape');
});

test('HTTP and worker preserve structured not-found and report unknown envelope fields', async t => {
  const f = await fixture(t); f.close();
  const app = await startServer({ dataDir: f.dir, port: 0 }); t.after(() => app.close());
  const post = body => fetch(`http://127.0.0.1:${app.port}/api/ui/call`, { method: 'POST',
    headers: { Authorization: `Bearer ${app.uiToken}` }, body: JSON.stringify(body) }).then(res => res.json());
  const missing = await post({ command: 'inspect', arguments: { taskId: f.taskId } });
  assert.equal(missing.error, 'missing-argument'); assert.match(missing.hint, /未知字段 arguments/);
  for (const args of [{ taskId: f.taskId }, JSON.stringify({ taskId: f.taskId })]) assert.equal((await post({ command: 'inspect', args })).id, f.taskId);
  const absent = await post({ command: 'inspect', args: { taskId: 'missing-record' } });
  assert.equal(absent.error, 'not-found'); assert.equal(absent.scanned, 1); assert.equal(absent.idLength, 14);
  assert.equal((await post({ command: 'inspect', args: '[]' })).error, 'invalid-arguments-shape');
});
