---
name: lingflow-controller
description: "在 DSH 主控会话接受用户执行授权、登记需求、推导任务约束并通过 LingFlow 派单。"
---

# DSH 主控执行

1. 接管或恢复上下文时读 `lingflow_team context` 的 `rules`（含主控回合规则）和项目约定。收到短卡时读 `inbox`，按相关任务核对。用户指定了项目内技能时先读对应文件。以用户在当前会话的明确授权为依据。清楚的执行指令可直接承接，讨论中的备选方案继续保留为草案。
2. 已有匹配需求则复用 ID，否则用 `approve` 记录目标、验收条件和用户确认摘录。只为真正的新业务取舍或权限边界提问。
3. 按 [拆票](../lingflow-to-tickets/SKILL.md) 核对 Git、活动票和前置。形成批准的 spec、tickets、planned attempts。需写入的工作用 `dispatchPlan` 绑定文档、真实读写、依赖、风险和验证计划。范围未知先发只读调查。
4. 沿稳定操作 ID 提交计划。结果不明时，用原 ID 查 `operation` 对账。拿到受理编号后，继续本轮可独立推进的事项。没有可执行事项时，立即结束本轮并等待系统回投。禁止为等结果轮询状态、休眠、运行循环或定时脚本，或委托其他 agent 代等。收到新事件或用户询问后，针对相关事项做一次有明确目的的核对。现场出现冲突时，等责任人 `yieldForSchedule` 回投确认停写，再用 `reviseSchedule` 调整原票并说明理由。
5. 收到交付后核对原 AC、候选、实际文件清单和程序回执。契约漂移先对账，证据缺失先补齐，有可复现的质量反例才判质量失败。返工需要改范围时用 `rework adjustScope=true` 暂停原票，再 `reviseSchedule`。高风险由独立审查回投；免审票用 `check` 提交冻结的独立验收，按回合规则等待结果，既有测试变更填 `testReview`。用 `summarize` 为每条 AC 引用对应的 `checkIds`，提供剩余限制和试用步骤，由用户验收。

提交计划前和处理结果后，执行 `lingflow_team context` 的主控回合规则中「并发派发」和「定向补位」。优先使用当轮已有的任务、成员与约束信息；已入队的票交给 LingFlow 放行。

默认收口顺序为：成员交付 → 主控独立探针或高风险独立审查 → summarize → 最后按用户已有授权提交。若确需提前提交，先用 diagnoseTask：已交付候选与提交内容完全等价时用 confirmCommit 显式确认并保留证据；否则沿原 rework→rebindCommittedWork 路径重跑绿、完整及适用独立检查。不要删除真实前置来恢复调度；已准入票的历史前置证明应由系统核对与保留。
