import assert from "node:assert/strict";
import path from "node:path";
import { apply } from "../adapters/dsh/index.mjs";

// Compatibility smoke against the installed defineTool, not a real model run.
export async function verifyDshContract({
  toolsModule,
  dataDir,
  workflow,
  projectRoot,
}) {
  const project = await workflow.call(
    "ui",
    "createProject",
    {
      name: "DSH 接口验证",
      root: projectRoot,
      members: [
        { kind: "controller", name: "主控" },
        { kind: "developer", name: "开发一" },
      ],
    },
    "dsh-contract-project",
  );
  const role = (await workflow.snapshot())
    .roles.find((r) => r.projectId === project.id && r.kind === "controller");
  const definitions = [],
    cleanup = [];
  const agent = {
    id: "contract-session",
    session: { header: { cwd: projectRoot } },
    ctx: {
      tools: {
        register: (def) => {
          definitions.push(def);
          return () => {};
        },
      },
    },
  };
  await apply(
    {
      agents: { list: () => [agent], get: () => agent },
      sessionController: {},
      on() {},
      logger: () => ({ warn() {} }),
      effect: (fn) => {
        const dispose = fn();
        if (dispose) cleanup.push(dispose);
      },
    },
    { toolsModule, dataDir },
  );
  try {
    assert.deepEqual(
      definitions.map((d) => d.name),
      ["lingflow_connect", "lingflow_team"],
    );
    const connect = definitions[0],
      team = definitions[1];
    const catalog = await connect.execute({}, { agent });
    assert.ok(catalog.some((p) => p.id === project.id));
    const request = await connect.execute({ roleId: role.id }, { agent });
    await workflow.call(
      "ui",
      "confirmBinding",
      { requestId: request.id },
      "contract-confirm",
    );
    await workflow.call(
      "ui",
      "enable",
      { roleId: role.id, enabled: true },
      "contract-enable",
    );
    const guide = await team.execute({ command: "guide" }, { agent });
    assert.match(guide.guide, /快速模式/);
    const inbox = await team.execute({ command: "inbox" }, { agent });
    assert.ok(inbox.notices.length);
    assert.equal(inbox.context.project.id, project.id);
    assert.equal(inbox.context.role.kind, "controller");
    const nextInbox = await team.execute({ command: "inbox" }, { agent });
    assert.equal(nextInbox.context, undefined);
    const context = await team.execute({ command: "context" }, { agent });
    assert.deepEqual(context, inbox.context);
    const requirement = await team.execute(
      {
        command: "approve",
        args: JSON.stringify({
          text: "回复 Hello",
          source: "验证对话中用户明确要求回复 Hello",
        }),
        operationId: "contract-approve",
      },
      { agent },
    );
    const developer = catalog
      .find((p) => p.id === project.id)
      .roles.find((r) => r.kind === "developer");
    const dispatch = await team.execute(
      {
        command: "dispatch",
        args: JSON.stringify({
          requirementId: requirement.id,
          developerId: developer.id,
          title: "回复 Hello",
          description: "在报告中返回 Hello",
          risk: "low",
          readOnly: true,
          writes: [],
          reads: [],
          resources: [],
          dependencies: [],
        }),
        operationId: "contract-dispatch",
      },
      { agent },
    );
    assert.equal(dispatch.receipt, "accepted");
    assert.equal(
      (await workflow.snapshot()).tasks.find((t) => t.id === dispatch.taskId)
        .requirementId,
      requirement.id,
    );
    return {
      passed: true,
      module: path.basename(toolsModule),
      scope: "真实安装包工具定义 + HTTP 绑定/身份/收件箱；无真实模型调用",
    };
  } finally {
    for (const dispose of cleanup.reverse()) await dispose();
  }
}
