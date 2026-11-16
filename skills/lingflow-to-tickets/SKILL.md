---
name: lingflow-to-tickets
description: "将批准的业务目标拆成独立可验收的 LingFlow 任务，并绑定实际调度约束。"
---

# 拆票与调度

1. 从有效基线、适用差异和用户批准的本轮目标出发。一票对应一项能单独演示的行为与验收边界。共享写集、相同验收时机的碎改优先合并。沿项目已有规划目录保存文件；没有既有位置时用 `.lingflow/planning/`。
2. 查相关实现、项目规则、Git 工作区和活动票。写集覆盖会改动的源码、测试和配置，读集覆盖改变会使实现或验证失效的关键输入。共享资源使用稳定名称，例如同一个数据库、端口、迁移或测试环境。范围不确定时先只读调查。纯调查、消息类责任设 `readOnly=true`、`writes=[]`。
3. 依赖只记录真正需要的上游结果及理由。为每张票取稳定 `key`。用 `after` 引用计划内票或已存在的任务。需要技术门槛用 `verified`，需要用户验收用 `accepted`。独立票省略前置。用 `scopePreview` 对照活动票查看冲突，读集带上检查输入。调度器按实际冲突排队。现场冲突由责任人停写后交回原票，主控更新调度。
4. 根据影响定风险。权限、数据完整性、迁移或跨模块公共契约变化通常为高风险；受控行为变化按影响定中风险；范围明确的局部改动、纯消息通常为低风险。高风险需独立审查。无审查者时等候。
5. 使用 [预定实施路线](../lingflow-to-planned-attempts/SKILL.md) 固定检查与边界。主控对照 `lingflow_team guide` 用 `dispatchPlan` 一次登记，记录受理编号和排队原因。按 [主控回合规则](../lingflow-controller/SKILL.md) 处理本轮可独立推进的事项，其余等待系统回投。用户负责业务取舍与检查授权。

在同一个票面 Markdown 的对应工单下维护机读约束。每张实施票用一个 JSON 围栏：

```lingflow-contract
{"ticket":"A","requiredWrites":["src/service.ts"],"requiredTestWrites":["test/service.api.test.ts"],"requiredAcceptance":["AC1","AC2"]}
```

`requiredWrites` 和 `requiredTestWrites` 只填本票必须修改的路径；只读取的文件留在 `reads` 或检查 `inputs`。对每个必改测试，在派发参数的 `writes`、`verification.testWrites` 和至少一项完整检查的 `inputs` 中核对相应路径。所有必验 AC 都须出现在 `verification.acceptance` 并关联完整检查。启用机读约束的票面中，每张派发的实施票都要有匹配的块。先用 `previewPlan` 验证同一份参数，再派发。
