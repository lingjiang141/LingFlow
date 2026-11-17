检查的环境／前置失败分类

工作进程和后端使用同一检测器。异常退出、进程信号、超时或 launchError 的检查，若命中以下事实，则记录 environmentFailure=true，并给出环境原因代码和顶层 reason：

- webserver-start-failed：Process from config.webServer was not able to start。
- esbuild-platform-mismatch：You installed esbuild for another platform。
- module-missing-before-tests：测试计数出现之前的 Cannot find module。
- webserver-port-or-connection：启动期间、或明确 webServer 上下文中的 EADDRINUSE／ECONNREFUSED。
- launch-error：非空 launchError，包括已声明构建前置无法完成或缺少构建产物。
- failed-before-tests：仅适用于 test 类，有效 startedAt→finishedAt 小于 2000ms，且没有测试用例执行信号。probe、compile、lint 不套用这条时间规则。

检查类型按冻结 argv 推断；环境检测与证据回读共用 `evidence-facts.mjs`。test 类的 AssertionError、ERR_ASSERTION、expect、Expected／Received 同样视为用例信号；No tests found／0 tests 仍是证据缺失，不能作为红证据。probe、compile 的 testCountSeen/testCaseSeen 为 null，表示不适用。

probe 红检查接受预期的非零退出码、expectedOutput 匹配，且输出包含本进程 Error 错误栈（含 at）或断言失败；不再要求把错误文案伪装成 AssertionError。有效红作业 state=passed、redEvidenceValid=true。非红探针的真实错误栈、编译检查的 error TS 数字错误码或 SyntaxError 可判为 quality-failed。模块／包缺失、esbuild 平台错误、服务启动与端口失败、launchError、signal、timedOut 仍不能充当红证据。退出码 0、错误退出码与预期不符、仅打印失败文案或截断日志均不能通过红门槛。

环境失败回执、checkStatus 和 inspect 摘要同时提供 evidenceKind、elapsedMs、matchedRule 与 redEvidenceRequirement，并保留原 checkId、argv、inputs 的重跑入口。旧 failed-before-tests 回执只在重新核算实际输出事实时可纠正；不会批量改写历史作业或自动重跑真实票。

确认完成且输入有效的环境失败记为 state=failed、classification=environment-failed，hint 为“先跑 npm run build 或修复本机依赖，不算票面红/绿证据”。回执和检查记录均保留原因，failureOutputSeen=false。普通检查 membersCanRetry=true，nextAction 为 check，引用原 taskId/checkId，并回显原 argv/inputs。累计检查由主控 retryBatch，原角色和阶段权限保持不变。

inspect 顶层汇总本回合尚未被后续成功结果覆盖的环境失败；checkStatus、checkEvidence 的检查记录顶层含环境事实，不需要翻日志。原始失败记录不会删除。相同 checkId 后续成功后，正常采用新的通过证据。诊断也会给出同一检查的重跑入口。

环境失败不产生红证明或绿／full 证据，不能被伪装的 passed 状态或历史红回执复用。冻结输入发生漂移时，原 contract-invalid／stale 优先，不能靠环境标签解除归属门槛；不确定的进程仍按原对账规则处理。

没有自动安装依赖、修改 node_modules、改写冻结 argv/inputs、跳过检查或改变 Git 历史。

验证：

    node --test tests/environment-failure.test.mjs tests/red-evidence.test.mjs
    npm test
    npm run check

用例包含真实检查子进程启动即退出、各环境签名、测试开始后的模块／连接错误、快速真实断言失败、红／绿修复后沿原冻结检查重跑至 full，以及环境诊断不得覆盖输入漂移的反例。

需重新加载 LingFlow 后端后生效；已结束的旧记录保持历史，不对它们批量重写。
