import { randomUUID } from "node:crypto";
import { installTools, missingTools } from "./tool-registration.mjs";

// SessionController.resolveAgent is the host's public persisted-session loader.
// Keep the resulting handles owned by the host; plugin disposal only removes tools.
export function createToolWatchdog({ ctx, definitions, bindings }) {
  const statuses = new Map(), repairs = new Map(), history = [];
  const record = event => { repairs.set(event.sessionId, event); history.push(event); if (history.length > 100) history.shift(); };
  let disposed = false;
  function ensure(agent) {
    if (disposed) return false;
    const before = missingTools(agent);
    let error;
    try { installTools(agent, definitions, setup => ctx.effect(setup)); }
    catch (failure) { error = failure.message; }
    const toolsMissing = missingTools(agent);
    const status = { sessionId: agent.id, toolsMissing, ...(error && { error }) };
    statuses.set(agent.id, status);
    if (before.length) record({ id: randomUUID(), sessionId: agent.id, ok: toolsMissing.length === 0, at: Date.now() });
    return !toolsMissing.length;
  }
  async function sweep() {
    const all = new Map(ctx.agents.list().map(agent => [agent.id, agent]));
    const ids = await bindings();
    await Promise.all(ids.map(async sessionId => {
      if (all.has(sessionId)) return;
      try {
        const resolved = ctx.agents.get?.(sessionId) ?? await ctx.sessionController.resolveAgent?.(sessionId);
        const agent = resolved?.agent ?? resolved;
        if (!agent || agent.error || agent.id !== sessionId) throw Error("绑定会话无法加载");
        all.set(sessionId, agent);
      } catch (error) {
        statuses.set(sessionId, { sessionId, toolsMissing: ["lingflow_connect", "lingflow_team"], error: error.message });
        record({ id: randomUUID(), sessionId, ok: false, at: Date.now() });
      }
    }));
    if (!disposed) for (const agent of all.values()) ensure(agent);
    return [...all.values()];
  }
  return { ensure, sweep, statuses: () => [...statuses.values()], repairs: () => [...repairs.values()], history: () => [...history],
    acknowledge(sent) { for (const event of sent) if (repairs.get(event.sessionId)?.id === event.id) repairs.delete(event.sessionId); },
    dispose() { disposed = true; },
  };
}
