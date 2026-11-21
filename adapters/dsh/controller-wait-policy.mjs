const waitTool = "wait_agent";
const policyCode = "LINGFLOW_CONTROLLER_WAIT";

export function createControllerWaitPolicy(ctx) {
  let controllers = new Set();
  let disposed = false;
  const restrictions = new Map(), failedRestrictions = new WeakSet(), waitSteps = new WeakMap();
  const isController = agent => controllers.has(agent?.id);

  function forget(agent) {
    const dispose = restrictions.get(agent);
    restrictions.delete(agent);
    dispose?.();
    if (agent.session) waitSteps.delete(agent.session);
  }

  function ensure(agent) {
    if (disposed || !isController(agent) || restrictions.has(agent)) return;
    try {
      if (!ctx.tools?.get?.(waitTool) || !agent.ctx?.tools?.restrict) return;
      restrictions.set(agent, agent.ctx.tools.restrict({ deny: [waitTool] }));
      failedRestrictions.delete(agent);
    } catch (error) {
      if (!failedRestrictions.has(agent)) ctx.logger?.("lingflow")?.warn?.("无法隐藏主控等待工具：" + error.message);
      failedRestrictions.add(agent);
    }
  }

  const unguard = ctx.tools?.guard?.(({ agent, name }) => name === waitTool && isController(agent)
    ? { reason: "LingFlow 成员回报会自动投递。无独立事项时结束本轮。",
      info: { name: "LingFlowControllerWait", code: policyCode } }
    : undefined);

  ctx.on("session/event", (session, event) => {
    const data = event.data;
    if (event.type === "assistant/message") {
      waitSteps.delete(session);
      const calls = data.message.content.filter(block => block.type === "tool-call");
      if (calls.length && calls.every(call => call.name === waitTool))
        waitSteps.set(session, { turn: data.turn, step: data.step, pending: new Set(calls.map(call => call.id)) });
    } else if (event.type === "tool/result") {
      const previous = waitSteps.get(session);
      if (!previous || previous.turn !== data.turn || previous.step !== data.step) return;
      if (data.message.isError && (data.error?.code === policyCode || data.error?.code === "UNKNOWN_TOOL"))
        previous.pending.delete(data.message.toolCallId);
    }
  });
  ctx.on("agent/disposed", ({ agent }) => forget(agent));

  return {
    ensure, isController,
    update(sessionIds, agents) {
      if (disposed) return;
      controllers = new Set(sessionIds);
      for (const agent of restrictions.keys()) if (!isController(agent)) forget(agent);
      for (const agent of agents) ensure(agent);
    },
    shouldYield({ agent, turn, step, messages }) {
      if (!isController(agent)) return false;
      const previous = waitSteps.get(agent.session);
      if (!previous || previous.turn !== turn || previous.step + 1 !== step) return false;
      waitSteps.delete(agent.session);
      // The preceding batch has settled. Do not veto a proposal with claimed
      // messages or parked input. A new user turn is always admitted normally.
      return previous.pending.size === 0 && messages.length === 0 &&
        agent.inbox?.nextTurn?.length === 0 && agent.inbox?.nextStep?.length === 0;
    },
    dispose() {
      disposed = true;
      controllers.clear();
      for (const agent of restrictions.keys()) forget(agent);
      unguard?.();
    },
  };
}
