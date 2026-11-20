---
name: to-tickets
description: "LingFlow: 将批准的业务目标拆成独立可验收的 LingFlow 任务，并绑定实际调度约束。"
disable-model-invocation: true
---

# 拆票与调度

1. 从有效基线、适用差异和用户批准的本轮目标出发。一票对应一项能单独演示的行为与验收边界。共享写集、相同验收时机的碎改优先合并。沿项目已有规划目录保存文件；没有既有位置时用 `.lingflow/planning/`。
2. 确认本批票的实际写入、关键读集和共享资源。路径、复现或检查入口只有读代码才能确认时，请成员定向只读定位并回报建议；主控裁决范围和风险。纯调查、消息类责任设 `readOnly=true`、`writes=[]`。
3. 依赖只记录真正需要的上游结果及理由。为每张票取稳定 `key`。用 `after` 引用计划内票或已存在的任务。技术门槛用 `verified`，用户验收用 `accepted`；显式 `after:[]` 表示不采用票面前置。不要用虚构的前置模拟写集冲突；LingFlow 会按写集、关键读集及资源排队。
4. 根据影响定风险。权限、数据完整性、迁移或跨模块公共契约变化通常为高风险；受控行为变化按影响定中风险；范围明确的局部改动、纯消息通常为低风险。高风险需独立审查。无审查者时等候。
5. 用 [本轮跨票协调](../to-planned-attempts/SKILL.md) 记录需要主控协调的事项。主控用 `schema {command:"dispatchPlan",requirementId,spec,ticketsDir,attempts}` 生成参数；同一目录有已派票时，按当前服务 guide 改传 `tickets:[本轮票面路径]`。`state=valid` 已完成预检，核对推荐责任人和资源警告后，在用户授权范围内直接提交 `args`。显式 `developerIds` 优先。修改过参数时用 `previewPlan` 核对，失败只处理报告指出的字段。

每张新实施票用 `# 票 R39-01：标题` 标识；在 `## 需求与 AC` 中写可观察行为及 `**AC-1**` 等稳定编号，在 `## 依赖与归属` 声明真实读集、前置及共享资源，在 `## riskAssessment` 写等级与理由。正文保留行为和验收，票面必写 `lingflow-contract`：

```lingflow-contract
{"ticket":"R39-01","requiredWrites":["src/service.ts"],"requiredTestWrites":["test/service.api.test.ts"],"requiredAcceptance":["AC-1"]}
```

`requiredWrites` 和 `requiredTestWrites` 只填必改路径；只读文件写进读集或检查 `inputs`。先写 `lingflow-checks` 时，JSON 对象含 `ticket`、完整 `checks` 和 `browserE2E`（无浏览器用例填 `[]`）。每条检查写实际 `id`、`stage`、JSON `argv` 数组、`inputs`、`covers` 和 `timeoutMs`，按需要加 `preSteps` 等冻结字段。红绿用同一命令、输入和 AC；红记录真实预期非零退出与行为断言标记，不能把启动、依赖或空跑失败当红。`full` 覆盖全部 AC、纳入每个必改测试。免审票由主控冻结低负载独立探针。

需要开发读实现才能确定检查时，在 `lingflow-contract` 填 `"developerChecks":true`。派发先冻结 AC、范围和资源。高风险票可省略 `lingflow-checks`；有主控探针时只在该围栏声明探针。责任开发接票后用 `registerChecks` 冻结实际检查。

浏览器 `browserE2E` 填 `file`、完整字面 `title`、`reason` 和 `covers`。具名检查的 `argv` 必须精确绑定这些值，例如 `["node","node_modules/@playwright/test/cli.js","test","(?:^|[/\\\\])e2e[/\\\\]paper\\.spec\\.ts$","--grep","(?:^|\\s)R39-01 导入后立即可用$"]`（JSON 中的反斜杠不可少；替换为本票真实文件与完整标题）。整文件回归用 `regression`，`covers:[]`。预检失败有 `repair` 时核对后替换到其 `path`；`requiresInput` 表示须补充现场事实，不照抄形状示例。
