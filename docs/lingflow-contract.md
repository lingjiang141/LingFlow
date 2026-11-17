# LingFlow 派发契约与 Hive 规划兼容

`lingflow_team` 的 `schema {"command":"dispatchPlan"}` 返回字段示例。`previewPlan` 使用与 `dispatchPlan` 同一组规则；通过时返回 `state:"valid"`、`violations:[]`、`warnings` 和归并后的范围及检查。无效时预检返回 `state:"invalid"`，每条违规含 `path`、`message`、`expected`、`remedy`。正式派发遇到违规会拒绝，原票和投递队列保持不变。

## 工具时限和归属扫描

在 LingFlow 数据目录的 `config.json` 中，保留现有字段并加入 `execution`。按项目 ID 覆盖的值优先。修改后重启服务，DSH 适配器会从服务读取对应会话的时限。

```json
{
  "execution": {
    "timeouts": { "lightMs": 5000, "evidenceMs": 60000, "writeMs": 300000 },
    "projects": {
      "<项目 ID>": { "timeouts": { "writeMs": 180000 } }
    }
  }
}
```

轻读、证据查询和写命令分别使用对应时限。`check` 可传 `async:true`，先登记后台作业，再校验归属和运行冻结命令。用 `checkStatus {jobId}` 查状态，收到 `reused` 时查看 `reusedJobId` 对应的有效证据。累计批次保持后台执行。`summarize` 使用写命令时限。

`rebindCommittedWork`、`diagnoseTask`、`deliveryEvidence` 使用状态与证据档，默认 60000ms；普通 `list` 等轻读仍为 5000ms。DSH 适配器给服务端的结构化超时回执留出传输余量。重绑超时不代表回滚或取消：回执含 `error:"timeout"`、`phase`、`elapsedMs`、`scannedFiles`、原 `operationId` 和后续查询指令；`state:"unknown"` 表示尚未确认落库，`state:"applied"` 表示已查到回执。使用完全相同的参数和 `operationId` 重试，已入库操作返回原结果及 `summary`，不重复变更基线。

`error:"timeout"` 包含阶段、耗时和已知的扫描数量。写操作用原 `operationId` 查回执，并用相同参数和编号重试。慢证据查询可返回原票记录和 `evidence.available:false`。作业记录的 `source` 区分 DSH 工具适配器和 HTTP 直连。

默认扫描 Git 跟踪的脏文件、票面写集和可见的未跟踪文件。归属扫描从未跟踪路径中过滤生成物，票面声明的路径仍进入检查。在 `execution.ownershipIgnores` 或 `execution.projects.<项目 ID>.ownershipIgnores` 中可用相对路径、`*` 和 `**/` 替换默认列表。`[]` 可关闭 LingFlow 的过滤，Git 自身忽略规则继续生效。`LingFlow ownership scan` 记录已核算指纹的文件数、缓存命中、Git 枚举与指纹耗时。`LingFlow ownership inventory` 在后台记录 Git 可见未跟踪总数和该次采样的忽略数量。

默认过滤包括 `node_modules`、各层 `dist`、`.git` 和 `.hive/build-cache`。重绑结果的 `scannedFiles` 表示归属核算涉及的范围外脏文件数，包含缓存命中，不是整个仓库文件数；票面写集与冻结输入另行校验，已跟踪文件不会因噪声过滤而被隐藏。超时回执采用最近收到的扫描进度。

## 新增测试与红证据

采用测试写集排除方案，无需先提交测试或新增 `testFirst` 字段。派发冻结路径和检查命令后，开发先编写 `testWrites`，保持实现文件与基线一致，运行 red；取得真实断言失败后修改实现，再运行 green 和 full。

测试发生变化时，版本 2 的 `redProof` 绑定已准入的实现基线、实现侧写集和非写集输入。回执显式列出 `redProofScope` 与 `excludedTestWrites`。独立的 `redTestProof` 配对实际运行的测试，防止取得红证据后将断言替换为空跑；改测试后须在实现基线上重跑 red。测试未变化的票保留旧红指纹算法，已有有效旧格式回执也可以继续核验。

红阶段必须非零退出、命中冻结失败标记，并在完整日志中检测到 `AssertionError`、`ERR_ASSERTION`、`expect(...)` 或 `Expected:` / `Received:` 等断言标记，且 `failureOutputSeen=true`。`No tests found`、零测试、启动或语法错误、截断日志，以及仅打印自定义 `assertion:` 字符串均不予接纳。浏览器断言自身的等待超时仍可作为真实失败；测试进程或启动超时不能代替断言。旧回执若 `failureOutputSeen=false`，也必须重新取得有效红证据。

## 原票被后继票替代或退出调度

主控使用 `supersede {taskId,supersededBy,reason}`。旧票必须处于 `paused` 或 `blocked`，且没有 queued/launching/uncertain 的检查；责任人仍在执行的票须先停写并 `yieldForSchedule`。写集存在暂存、未暂存、未跟踪或被 Git 忽略的在途改动时，释放回执显式给出 `handoff:{ticketKey,writes,ownedDirty,instruction}` 和 `nextAction:{command:"dispatchPlan",args:...}`。文件原样保留，由开发成员承接，主控不得接手实现或代为提交；工作树干净时省略 handoff。承接提案不等于新增授权，仍须 previewPlan、规划正文和归属准入校验。原基线已经漂移或冻结契约已不可满足，不妨碍在上述条件下替代旧票。

替代后旧票为 `superseded`，退出读集、写集、检查输入及共享资源的并发占用；保留原范围、冻结契约、基线、报告、审查、检查作业和日志，通过 `inspect {taskId}`、`checkEvidence {jobId}` 仍可读取。审计记录包含主控、原因、时间和后继票。后继票同项目且未收尾，原有等待票的依赖转向后继票；后继票移除对旧票的自等待并继承旧票的其他前置，verified/accepted 门槛不会降低，存在依赖环时整次操作被拒绝。旧票不因此成为“已验收”；后继票满足其余准入条件后立即进入调度。

仅需释放收尾票时，主控可用 `releaseSchedule {taskId,reason}`。暂停的实施票也可使用 `reviseSchedule {taskId,writes:[],reason}`，不要混传其他调度调整。两者执行相同停写和检查收口门禁，保存 `releasedScope` 快照并清空当前 writes；原票保持 paused/blocked，不再自动准入，其冻结检查也不再占用读集。`abandonTask` 同样提供在途改动承接回执。已释放票不能再次释放、confirmCommit 或 rebindCommittedWork；诊断发现原写集仍有改动时分类为 `controller-takeover-risk`，直接返回含 ownedDirty 的承接参数。

冲突回执带 `peerState`、`remedy` 和 `nextAction`。对同项目的 paused/blocked 对端，已有后继票 ID 时会给出完整 `supersede` 参数；其他情况先 `inspect`，不会指示主控强制终止 active 票。`schema {command:"supersede|releaseSchedule"}` 可分别查询新命令的约束。使用稳定 operationId 重试读取同一回执。

## 主控边界、证据回投与提交审计（F25/F26）

主控不得写业务代码、执行 red/green/full/regression、e2e 或 npm run build 等构建。只允许通过 `check` 提交冻结的 independent/controller 探针，时限仍为 60000ms。相同开发命令、相同入口追加参数、覆盖 full 全部 inputs 和 covers 的复制探针，以及通过 shell/子进程转发的包装探针均被拒绝。full 的全部 AC 覆盖门槛保持不变。

`diagnoseTask` 的证据阻塞返回 `nextAction.ownerRole` 与 `ownerId`。开发检查始终指向原票 developerId，与在线情况无关；主控只能执行 ownerRole=controller 的冻结探针。已交付票缺证时，`nextAction.returnToOwner` 给出主控可执行的 `rework {taskId,reason,evidence:[checkId]}`；`nextAction.command=check` 是责任开发成员的动作。仍在实施的票由原开发成员沿原票重跑，主控不会代跑。

`rework.evidence` 只接受本票冻结的非主控检查 id。`task.reworkEvidence` 保存待办；成员 inbox 逐条列出检查 id、上次 classification 和原因。指定检查通过新有效回执后逐项移除。记录本次返工要求的 revision，防止旧通过记录被复用来消除待办；未被指定且仍有效的其它证据可以复用。

`governance {limit:50}` 为只读命令，无需 operationId。主控只可查看本项目，工作台可按 projectId 选择项目。最多扫描最近50个提交，返回每个项目的 `{commit,ticketKey,files,at,kind}` 记录。未曾 summarize 的票，提交触及其 writes 时记录 in-flight-work-committed；释放后提交则记录 released-work-committed。新释放审计保存当时 Git HEAD，避免同一秒内提交与释放的先后关系被时间戳误判。结果表示范围和流程风险，不能据 Git 作者名证明是主控或开发者实际提交。

上述命令只更新 LingFlow 状态和审计，不提交、回滚、修改项目文件或改写 Git 历史。写集尚有内容时保留现场，由主控先核对归属。累计验证批次的契约不会自动改写，涉及旧票的分组仍须主控沿原批次核对。

## 派发字段

| 字段 | 用法 |
| --- | --- |
| `requirementId` | 主控已登记的用户授权；读取 Hive 文档不等于执行授权。 |
| `sources.spec` / `sources.attempts` | 项目相对路径，分别指向规格和预定路线。 |
| `sources.tickets` / `sources.ticketsDir` | 三选一：聚合票面路径、原票文件路径数组、包含原票 Markdown 的目录。多文件以 H1 票号定位；旧的 `lingflow-contract` 仍支持。 |
| `tickets[].key` / `developerId` | 稳定票号和本项目开发成员 ID。 |
| `writes` / `reads` | 显式项目相对路径；缺省或 `"from-ticket"` 可从 Hive 归属段派生。实施票空写集也尝试派生。歧义路径由主控补足；条件写入不自动纳入。背景阅读单列 `contextReads`。 |
| `after`、`resources` | 前置门槛与共享资源。Hive 的「前置」可派生成 verified；若必须等业务验收，用 accepted 显式声明。共享端口、数据库等资源必须如实声明。 |
| `verification.acceptance` / `testWrites` | 原票 AC 和允许写入的行为测试文件，可从已识别票面派生。测试路径仍须属于 writes；已有测试满足验证需求时，内容可以与基线完全一致，不强制修改。 |
| `verification.browserE2E` | 具名浏览器证据：`{file,title,reason,covers}`；也接受票根声明，不能两处冲突。兼容 Hive 票面显式用例标题与能唯一定位它的票号筛选。 |
| `verification.checks` | 实际可执行的 `argv`、冻结 `inputs`、`covers`、退出和断言规则。票面用自然语言描述验证时，主控提供真正可运行的检查，不由程序猜命令、失败原因或覆盖证据。 |

简例：原票已有 `AC-1`、写集和测试归属，主控提交下面的结构，不必改 Markdown：

```json
{
  "requirementId": "USER-APPROVAL-ID",
  "sources": {"spec":"spec.md","ticketsDir":"issues","attempts":"planned-attempts.md"},
  "tickets": [{
    "key":"R35-01","developerId":"ROLE-ID","writes":"from-ticket","reads":"from-ticket",
    "verification":{"checks":[
      {"id":"focus","stage":"green","argv":["node","verify.cjs"],"inputs":["verify.cjs","test/feature.test.cjs"],"covers":["AC-1"],"deriveRed":true,"redExpectedExit":1,"redExpectedOutput":"AssertionError: expected behavior"},
      {"id":"complete","stage":"full","argv":["node","verify.cjs","full"],"inputs":["verify.cjs","test/feature.test.cjs"],"covers":["AC-1"]},
      {"id":"probe","stage":"independent","argv":["node","probe.cjs"],"inputs":["probe.cjs"],"covers":["AC-1"],"timeoutMs":15000}
    ]}
  }]
}
```

- **red / green**：argv 按顺序比，inputs 按规范化集合比，covers 按集合比。预检列出不同字段。缺少配对 red 时，可从已声明的 `redExpectedOutput` 或 `failureOutput` 派生预期非零退出的红检查；也可用 `deriveRed:true` 显式请求。没有真实断言信号就拒绝派生。仍需执行并观察断言失败；不会自动改源码来制造红。
- **full**：开发的 AC 验证。多条 full 可以分摊覆盖，但并集必须覆盖所有 AC。
- **regression**：开发的额外回归门，`covers:[]`。可运行 Playwright 整文件或整个测试套件；整套时列出所有测试文件，使执行范围与冻结输入一致。无退出成功的回执不能交付；回归回执不能冒充 AC 或三维证据。
- **independent / controller**：主控独立验收或收口短探针，最多 60000ms，不能跑浏览器或全量测试。高风险票仍须独立审查。

浏览器阶段允许表也由 `schema {"command":"previewPlan"}` / `schema {"command":"dispatchPlan"}` 的 `browserChecks.stages` 返回：

| 阶段 | 浏览器命令 | 范围与 covers |
| --- | --- | --- |
| red | 允许，由开发运行 | 一个已声明文件和完整标题；inputs 包含文件，covers 包含该用例的 browserE2E.covers。 |
| green | 允许，由开发运行 | 同 red；与配对 red 的 argv、inputs、covers 同键。 |
| full | 允许，由开发运行 | 同一具名用例绑定；每条 browserE2E 至少有一个匹配的 full。 |
| regression | 允许，由开发运行 | 显式列出冻结的整文件，不加 --grep；covers 必须为 []，不替代 AC 证据。 |
| independent / controller / batch | 不允许 | 浏览器检查交责任开发；主控只运行低负载短探针。 |

red、green、full 的 covers **不要求与 browserE2E.covers 完全相等**，可以额外包含本票 AC；漏掉用例 AC 时，预检报 `.covers` 和“covers 不一致”，回显两边的 covers。缺失冻结文件报 `.inputs`。只有命令本身不同才报 `.argv`，消息完整保留“收到 argv”和“期望 argv”的 JSON 值。

比较前会对直接 Playwright CLI 参数字符串化并 trim，统一路径分隔符及语义等价的正则转义。不会再次 JSON 解码，也不会把匹配字面反斜杠的正则当作空白字符正则。已入库的测试无需在 red 与 green 之间修改：基线实现先真实断言失败，再只改实现，通过 green 和 full。若现有实现已经通过该用例，则不能伪造 red，仍需选择能证明未实现行为的真实断言。

`lingflow_connect` 的 `effective` 表示当前真实会话已绑定且角色已开启；`deliveryBlocker` 另报是否离线、忙或处于恢复。派发 `accepted` 表示登记成功，`runnable` 和 `blockedBy` 表示即时可执行性；`deliveredAt` 只在真实送达回执或成员读到原任务后写入。

## 迁移改动

- F1：支持 issues 目录、文件数组及聚合票面，按 H1 绑定冻结原文件。
- F2：结构化汇报独立违规；schema 提供字段形状，未知字段警告。
- F3：增加独立 regression 阶段，保留 full 的 AC 覆盖门槛。
- F4：票根浏览器声明显式归并，也可从 Hive 的具名用例派生。
- F5：公开红绿配对键，指出差异字段；支持带失败断言的 red 派生。
- F6：主控探针明确上限和实际值；全量测试与浏览器仍交开发。
- F7：从原票派生范围与前置，回显差异和未决路径，不猜条件授权。
- F8：绑定有效性和送达分开；离线可登记，不冒报已投递。
