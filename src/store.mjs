import { DatabaseSync } from "node:sqlite";
import { operationIdIssue } from "./compliance-errors.mjs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// One synchronous transaction owns domain state, outbox and operation receipts.
export class Store {
  constructor(file, { readOnly = false } = {}) {
    this.directory = dirname(file);
    if (readOnly) {
      this.db = new DatabaseSync(file, { readOnly: true });
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (scope TEXT, id TEXT, input TEXT, result TEXT, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, kind TEXT, data TEXT);`);
    this.db.prepare("INSERT OR IGNORE INTO state VALUES(1,?)").run(
      JSON.stringify({
        projects: [],
        roles: [],
        promptPresets: [],
        requirements: [],
        tasks: [],
        notices: [],
        wakes: [],
        requests: [],
      }),
    );
  }
  read() {
    return JSON.parse(
      this.db.prepare("SELECT data FROM state WHERE id=1").get().data,
    );
  }
  change(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.read();
      const result = fn(state);
      this.db
        .prepare("UPDATE state SET data=? WHERE id=1")
        .run(JSON.stringify(state));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  event(kind, data) {
    this.db
      .prepare("INSERT INTO events(at,kind,data) VALUES(?,?,?)")
      .run(Date.now(), kind, JSON.stringify(data));
  }
  wakeLossCounts() {
    return new Map(this.db.prepare(`SELECT json_extract(data,'$.wakeId') AS id, count(*) AS losses
      FROM events WHERE kind='wake.delivery_lost' GROUP BY id`).all().map(({ id, losses }) => [id, losses]));
  }
  taskEvents(taskId, {offset=0,limit=3}={}) {
    if (!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200) throw Error('events offset 须非负，limit 须为1–200');
    const join = `FROM events e LEFT JOIN operations o ON o.scope=json_extract(e.data,'$.scope') AND o.id=json_extract(e.data,'$.operationId')
      WHERE json_extract(e.data,'$.taskId')=? OR json_extract(o.input,'$.args.taskId')=?`;
    const total=this.db.prepare('SELECT count(*) AS total '+join).get(taskId,taskId).total;
    const items=this.db.prepare(`SELECT e.seq,e.at,e.kind,json_extract(e.data,'$.operationId') AS operationId,
      CASE WHEN e.kind IN ('input.drop-requested','input.drop-completed','input.drop-obsolete') THEN e.data END AS dropDetails,
      CASE WHEN e.kind IN ('supersede-task','abandon-task') AND json_type(e.data,'$.stopProof') = 'object' THEN e.data END AS scopeDetails
      ${join} ORDER BY e.seq DESC LIMIT ? OFFSET ?`).all(taskId,taskId,limit,offset)
      .map(({dropDetails,scopeDetails,...item})=>({
        ...item,
        ...(dropDetails && {inputDrop:JSON.parse(dropDetails)}),
        ...(scopeDetails && {scopeRelease:JSON.parse(scopeDetails)}),
      }));
    return {taskId,section:'events',items,offset,limit,total,scanned:total,truncated:offset+items.length<total,
      nextOffset:offset+items.length<total?offset+items.length:null};
  }
  operation(scope, id, input, fn) {
    const issue = operationIdIssue(input.command, id, { force: true });
    if (issue) throw Object.assign(Error(issue.remedy), { argumentIssue: issue });
    return this.change((state) => {
      const encoded = canonical(input);
      const old = this.db
        .prepare("SELECT * FROM operations WHERE scope=? AND id=?")
        .get(scope, id);
      if (old) {
        if (old.input !== encoded)
          throw Error("同一 operationId 不能用于不同内容");
        return JSON.parse(old.result);
      }
      const result = fn(state);
      this.db
        .prepare("INSERT INTO operations VALUES(?,?,?,?)")
        .run(scope, id, encoded, JSON.stringify(result));
      this.event(input.command, { scope, operationId: id });
      return result;
    });
  }
  receipt(scope, id) {
    const row = this.db
      .prepare("SELECT result FROM operations WHERE scope=? AND id=?")
      .get(scope, id);
    return row
      ? { state: "stored", result: JSON.parse(row.result) }
      : { state: "unknown" };
  }
  close() {
    this.db.close();
  }
}
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
