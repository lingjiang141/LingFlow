import { readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRelay } from "./relay.mjs";
import { parseCommandRequest, commandExamples } from "../../src/command-arguments.mjs";
import { activeDshJobs, createDshTelemetry } from "./telemetry.mjs";
import { commandTimeout, commandTimeoutResult, executionPolicy } from "../../src/execution-policy.mjs";
import { installedToolsVersion } from "./tool-registration.mjs";
import { createToolWatchdog } from "./tool-watchdog.mjs";

export const name = "lingflow-dsh";
export const inject = ["tools", "agents", "sessionController", "jobs"];
export async function apply(ctx, config) {
  const { defineTool } = await import(pathToFileURL(config.toolsModule));
  const connection = JSON.parse(
    readFileSync(path.join(config.dataDir, "config.json"), "utf8"),
  );
  const origin = `http://127.0.0.1:${connection.port}`;
  const defaults = executionPolicy(connection.execution);
  const abort = new AbortController();
  const health = (error = null) => {
    const file = path.join(config.dataDir, "dsh-status.json");
    try {
      writeFileSync(
        file + ".tmp",
        JSON.stringify({
          loaded: true,
          at: Date.now(),
          error,
          tools: ["lingflow_connect", "lingflow_team"],
          installedToolsVersion,
          sessions: watchdog.statuses(),
          toolsReinstalls: watchdog.history(),
        }),
      );
      renameSync(file + ".tmp", file);
    } catch {
      // Status telemetry must never interrupt session work.
    }
  };
  const api = async (action, body, timeoutMs = defaults.timeouts.lightMs) => {
    const response = await fetch(origin + "/api/bridge/" + action, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + connection.bridgeToken,
        "X-LingFlow-Client": "dsh-adapter",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]),
    });
    const value = await response.json();
    if (!response.ok) throw Error((value.code ? "[" + value.code + "] " : "") + (value.error || "LingFlow 请求失败") + (value.violations ? "\n" + JSON.stringify(value.violations) : ""));
    return value;
  };
  const relay = createRelay({
    file: path.join(config.dataDir, "dsh-admissions.json"),
    agents: ctx.agents,
    controller: ctx.sessionController,
    activeJobs: (agent) => activeDshJobs(agent, ctx),
    api,
    signal: abort.signal,
    ensureTools: agent => watchdog.ensure(agent),
  });
  const output = {
    schema: { type: "json" },
    render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
  };
  const definitions = [
    defineTool({
      name: "lingflow_connect",
      description:
        "列出 LingFlow 项目角色；指定 roleId 后请求绑定当前真实会话。用户在独立窗口确认并手动开启。",
      parameters: { roleId: { type: "string" } },
      output,
      async execute(args, exec) {
        if (!exec.agent) throw Error("需要 DSH 会话");
        return args.roleId
          ? api("request", {
              roleId: args.roleId,
              sessionId: exec.agent.id,
              cwd: exec.agent.session.header.cwd,
            })
          : api("catalog", {});
      },
    }),
    defineTool({
      name: "lingflow_team",
      description:
        "LingFlow 快速工作流。guide 获取参数，inbox 读待办，context 读角色，inspect 读原票。主控 approve、dispatchPlan、reviseSchedule、redeliver、check、summarize。只读票可 dispatch。开发 check、report、question、yieldForSchedule，审查 review。监管用 message 转达用户消息，主控用 message 携带 replyTo 回复；inbox 收新消息，messages 查询原消息。后台作业用 checkStatus/checkEvidence，写操作使用稳定 operationId。\n最小参数形状示例（仍须满足原契约）：\n" + commandExamples,
      parameters: {
        command: { type: "string", required: true },
        args: { type: "json", description: "仅接受命令参数的 JSON 字符串或普通对象；嵌套负载放在 args 字段；其他形态返回 invalid-arguments-shape" },
        operationId: { type: "string" },
      },
      output,
      async execute(args, exec) {
        if (!exec.agent) throw Error("需要 DSH 会话");
        const parsed = parseCommandRequest(args);
        if (parsed.error) return parsed;
        const parameters = parsed.args;
        const request = {
          sessionId: exec.agent.id,
          command: args.command,
          args: parameters,
          operationId: args.operationId,
        };
        const started = performance.now();
        const { timeoutMs } = await api("policy", { sessionId: request.sessionId, command: request.command }).catch(() => ({}));
        const budget = Math.max(100, Number.isSafeInteger(timeoutMs) ? timeoutMs : commandTimeout(request.command, defaults));
        try {
          const result = await api("call", request, budget + 500);
          return parsed.warnings.length && result && typeof result === "object" && !Array.isArray(result)
            ? { ...result, warnings: [...(result.warnings ?? []), ...parsed.warnings] } : result;
        } catch (error) {
          if (error.name !== "TimeoutError" && error.name !== "AbortError") throw error;
          const timeout = commandTimeoutResult(request, Math.round(performance.now() - started));
          if (!args.operationId || abort.signal.aborted) return timeout;
          const receipt = await api("call", {
            sessionId: exec.agent.id, command: "operation", args: { id: args.operationId },
          }).catch(() => null);
          if (receipt?.state === "stored") return { ...receipt.result, recoveredOperationId: args.operationId };
          return {
            ...timeout,
            receiptState: receipt?.state ?? "unavailable",
            message: timeout.next,
          };
        }
      },
    }),
  ];
  const observe = createDshTelemetry(ctx);
  const watchdog = createToolWatchdog({ ctx, definitions, bindings: async () => (await api("bindings", {})).sessions });
  const install = agent => watchdog.ensure(agent);
  ctx.on("agent/created", ({ agent }) => install(agent));
  ctx.on("agent/status", ({ agent }) => install(agent));
  ctx.on("agent/pre-step", ({ agent }, next) => {
    if (!install(agent)) throw Error("bridge-tools-missing：LingFlow 工具无法注册，请检查桥接状态");
    return next?.();
  });
  for (const agent of ctx.agents.list()) install(agent);
  await watchdog.sweep().catch(error => ctx.logger?.("lingflow").warn(error.message));
  health();
  let lastError = "";
  const deliveryErrors = new Set();
  const timer = setInterval(async () => {
    if (timer.busy) return;
    timer.busy = true;
    try {
      const diagnostics = relay.diagnostics();
      const agents = await watchdog.sweep();
      const repairs = watchdog.repairs();
      const sessions = agents.map((a) => ({
        id: a.id,
        state: a.status,
        pending:
          (a.inbox?.nextTurn?.length ?? 1) + (a.inbox?.nextStep?.length ?? 1),
        jobs: activeDshJobs(a, ctx),
        telemetry: observe(a),
        toolsVersion: installedToolsVersion,
        toolsMissing: watchdog.statuses().find(status => status.sessionId === a.id)?.toolsMissing ?? [],
        toolsReinstall: repairs.find(event => event.sessionId === a.id),
        deliveryResults: diagnostics.filter((d) => d.id.startsWith(a.id + ":")).slice(-30)
          .map(({ id, state, reason, attempt, generation, at, outcomes }) => ({
            wakeId: id.slice(a.id.length + 1), state, reason, attempt, generation, at, outcomes,
          })),
      }));
      for (const status of watchdog.statuses()) if (!sessions.some(session => session.id === status.sessionId))
        sessions.push({ id: status.sessionId, state: "offline", pending: 1, jobs: null, toolsMissing: status.toolsMissing,
          toolsReinstall: repairs.find(event => event.sessionId === status.sessionId) });
      const response = await api("heartbeat", { sessions });
      watchdog.acknowledge(repairs);
      void relay.accept(response.deliveries).catch((error) => {
        if (!abort.signal.aborted && !deliveryErrors.has(error.message)) {
          if (deliveryErrors.size >= 32) deliveryErrors.clear();
          deliveryErrors.add(error.message);
          ctx.logger("lingflow").warn(error.message);
        }
      });
      lastError = "";
      health();
    } catch (error) {
      if (!abort.signal.aborted && lastError !== error.message) {
        ctx.logger("lingflow").warn(error.message);
        lastError = error.message;
        health("服务连接或投递暂不可用，请检查 LingFlow");
      }
    } finally {
      timer.busy = false;
    }
  }, 2000);
  ctx.effect(() => () => {
    clearInterval(timer);
    watchdog.dispose();
    abort.abort();
  });
}
