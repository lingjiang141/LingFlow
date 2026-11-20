# LingFlow 全局技能运行约定

默认工作流是 LingFlow。保留 /to-spec、/to-tickets、/to-planned-attempts 的旧调用名，内部依次读取同级技能即可，无需用户重复输入命令。

- 主控先用 lingflow_team context 恢复职责、guide 查询真实签名。从用户确认范围形成规格、票据和预定路线，经 approve 与 previewPlan 后用 dispatchPlan 登记；保持稳定 operationId，超时查 operation。
- 规划是待绑定路线，不是实施授权或完成证据。票面写明验收、真实读写、testWrites、inputs、共享资源及必要前置。已派原票按冻结版本执行，调整由主控沿原票登记。
- 写入票先在实现保持基线时取得真实断言失败，再执行同一冻结绿检查和完整检查。空跑、启动失败、依赖问题不充当红证据；environment-failed 沿同 checkId 修环境后重试。测试文件也是交付物时按冻结契约允许的测试先行路径执行。
- report/review 引用真实 checkIds、候选及 requirements/implementation/system 三维证据。高风险由独立审查者处理；免审票由主控执行冻结的独立验收。summarize 的 decision.testReview 在报告有测试变更时须为非空字符串，描述断言与覆盖核对。
- 交付、送达、检查通过、技术收口与用户验收分别核对。以真实回执为证据，不以口头自报替代验收。
- 有独立可执行责任就处理；无可执行事项立即结束回合，等 LingFlow 回投，不为等结果轮询、休眠或另建代等代理。仅处理原生团队责任；技能不自行创建宿主子代理、集成分支或合并流水线。
- 冲突先停写并 yieldForSchedule，再由主控 reviseSchedule；静默恢复与废票处理先 diagnoseTask，再按 guide 使用 resumeTask/supersede 等实际命令，保留历史和归属验证。
- 工具嵌套负载放 args（JSON 字符串或对象），写操作带稳定 operationId。参数以当前 guide/schema 为准，不编造字段。Codex 当前会话没有 LingFlow 工具时，可完成规划与只读核对，派发和入库交给已绑定的 DSH 主控；不用旧工作流命令替代。
- Git、试验隔离和外部发布依用户及项目授权执行，主控不能把规划、角色身份或技能当作额外授权。
