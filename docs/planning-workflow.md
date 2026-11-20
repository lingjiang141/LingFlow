# 用技能推进 LingFlow 项目

安装并接入 DSH 后，在项目目录打开主控会话。发布包里的 [skill-pack](../skill-pack/) 是本机使用的宿主技能副本。LingFlow 的工作流照常提供角色、派单和验收工具，内置技能注入默认停用。

## 安装宿主技能

1. 从仓库取 [skill-pack](../skill-pack/)，或下载 [Releases](https://github.com/lingjiang141/LingFlow/releases/latest) 里的技能 ZIP。Windows 程序目录也有 `resources/app/skill-pack/`。
2. 把六个同名技能目录连同 `domain-modeling` 复制到 DSH 的用户技能目录，默认是 `%USERPROFILE%\.dsh\skills`。如需从 Codex 调用，把相同目录复制到 `%USERPROFILE%\.codex\skills`。各目录应直接包含其 `SKILL.md`。
3. 把包中 `implement/references/harness-runtime.md` 放到同一宿主技能目录内的对应相对位置。`domain-modeling` 供 `grill-with-docs` 调用。`implement` 下随包提供的是运行约定文件。已有同名技能时，先保留旧副本并核对差异。
4. 刷新宿主技能或重新打开会话，确认能调用下表的技能。DSH 主控绑定后可登记和派单，成员通过 LingFlow 收到责任。

| 技能 | 使用时机 |
| --- | --- |
| `setup-matt-pocock-skills` | 新项目做一次，设置事项追踪和领域文档位置 |
| `grilling` | 通过逐轮问答确认目标、边界和取舍 |
| `grill-with-docs` | 在问答中同步沉淀术语表和需要长期保留的架构决策 |
| `to-spec` | 写首轮完整规格，或记录后续差异规格和修复验收 |
| `to-tickets` | 按本轮规格拆成可独立验收的实施票，登记读写和依赖 |
| `to-planned-attempts` | 记录跨票顺序、共享边界和停手条件供主控协调 |

## 从空文件夹到第一轮交付

1. 在空项目文件夹启动主控会话，主动调用 `setup-matt-pocock-skills`。按项目情况确认使用 GitHub Issues、其他追踪器或本地 Markdown，以及领域文档布局。需要派发实施票时，先为项目准备 Git 基线提交。
2. 用 `grilling` 问答形成初稿，需要一起落术语表或 ADR 时用 `grill-with-docs`。接着用 `to-spec` 整理完整规格，用 `to-tickets` 拆票，用 `to-planned-attempts` 记下本轮跨票协调。
3. 确认方案并授权执行后，由主控登记批准并派发，主控协调成员实现和回报，用户在工作台验收。

## 后续修复、追加功能与在途调整

- 每轮从当前生效的规格出发，依次用 `to-spec`、`to-tickets`、`to-planned-attempts` 形成这轮方案。修复记录写明原验收、复现与预期。追加功能写明差异与受影响的验收条款。自己也拿不准时，先用 `grilling` 或 `grill-with-docs` 澄清。
- 流水线进行中可直接和主控讨论新要求。成员回报先进入收件箱，等主控与用户当前这一次对话回合结束，LingFlow 自动投递排队回报。用户可以继续下一轮讨论。
- 主控发现实现方向需要纠正时，可沿原票发送实施指导或请求停写。接到停写请求后，成员在安全边界确认，等待相关检查收口，保留工作和归属记录。
- 更新规格版本和受影响的验收条款后，主控可让原票按冻结的验收继续、补差异票，或在原票停写并核对交接后作废换票。变更了读写范围或依赖时，以主控登记的调度修订为准。
