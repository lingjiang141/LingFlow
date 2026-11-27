# LingFlow 派发契约与 Hive 规划兼容

`lingflow_team` 的 `schema {"command":"dispatchPlan"}` 返回字段示例。`previewPlan` 使用与 `dispatchPlan` 同一组规则；通过时返回 `state:"valid"`、`violations:[]`、`warnings` 和归并后的范围及检查。无效时预检返回 `state:"invalid"`，每条违规含 `path`、`message`、`expected`、`remedy`。正式派发遇到违规会拒绝，原票和投递队列保持不变。

## 派发、恢复与验收

- `after` 只声明确需等待的 `verified` 或 `accepted` 门槛。已入库的代码依赖记录 SHA 并声明真实 `reads`。端口、数据库和环境互斥写进 `resources`。预检会提示已经核实入库的前置，原依赖门继续生效。
- 同分支的安全快进可以更新审计基线。准入时明确承接的脏文件仍属于本票冻结写集。与冻结范围无交集、已提交且工作树干净的票外旧脏文件可以自动出列，审计为 `baseline-other-pruned`。冻结路径暂存、非快进和未知归属继续拦截。
- 开发检查回执复用要核对冻结配方、同内容输入、产物和完整日志。red 及 regression 不得用作 AC 验收证据。独立探针按相同规则复用。显式要求重跑或口径切换会单独标记对应旧回执失效。
- `diagnoseTask` 在状态副本上执行建议的恢复命令，回传实际阻碍。主控可调用 `unblock {taskId,reason}` 执行可自动完成的一步。提交归属核对须按回执单独确认。
- 普通提问和定向消息用 `question` 和 `message`。显式 `blocking:true` 只拦该角色的阶段。主控答复后可沿原票恢复，`resume:false` 可保留暂停。试用期间只推送真实的新责任或定向沟通。唤醒未读分别等候 120、240、480 秒。达到上限后，工具可用且原会话确认空闲时自动续接一次。主控可执行 `rearmWake {roleId,reason}`，成员面板也提供「恢复未读投递」。原通知可继续从原会话的 `inbox` 读取。
- 试用仍以用户结论为准。工作台和主控可以用 `accept {taskId,evidence}` 记录真实试用结果，回执保存验收角色、候选及时间。规划版本变化写入交付与汇总回执，原票沿用派发时的 AC。

新实施票使用 `candidateScope:2`。候选指纹覆盖冻结的 `writes` 和 `testWrites`，成功交付时保存完整路径快照。`reads` 和检查输入继续参与各自检查的有效性核对。其他票提交共享检查输入时，`diagnoseTask` 会指出需要重跑的检查。旧票保留原指纹口径和现有历史。

后续提交覆盖已验证票的写集时，如果原分支历史能完整重建原交付，且写集工作树与当前提交一致，主控仍可核对原交付并记录用户验收。`diagnoseTask` 显示 `historicalCommit`，证据查询和验收回执显示 `deliveryCommit`。差异取自该提交，历史检查回执对应原交付时的输入。缺少等价提交、回执失效或写集有未提交变化时，须先处理诊断给出的阻碍。

## 活规格与冻结票面

票在飞时，主控可以及时更新 `spec.md`。新计划必须在文档头部写 `Version: vN` 或 `Version: N`，并包含 `## 变更记录`。修订时递增版本并追加一行。协调事项可随时更新到 `planned-attempts.md`。

| 日期 | 版本 | 改了什么 | 影响 AC | 影响在飞票 |
| --- | --- | --- | --- | --- |
| 2026-11-19 | v2 | 修订评分描述 | AC-3 | R1-02 |

联动使用「影响 AC」和「影响在飞票」列中的编号。可填写多个以逗号、顿号或空格分隔的编号，无影响填 `—`。票的 AC 引用来自派发契约和票面明确声明的 `covers: AC-3`。命中后，`diagnoseTask`、`report` 与主控收件箱提供受影响票号和三种操作。主控可以保持冻结口径、追加新票，或停写后作废重派。

派发时保存 spec 的版本、正文和原始字节摘要。没有版本的旧票用摘要审计，历史票的版本不会回填。`report` 和 `diagnoseTask` 的 `sourceNotes` 保留前后摘要，验收摘要显示派发时与当前的 spec 版本。`inspectPlan {planId,document:"spec"}` 返回派发正文、当前摘要以及变化起始行和片段。只供背景阅读的规划路径应放在 `contextReads`，避免被列为候选、脚本或检查的实际证据输入。

禁止直接编辑在飞票面的 AC、写集和检查。票面按派发时的字节冻结，新增事项使用独立的新票面文件。写集需要调整时，恢复冻结票面，责任人停写后由主控执行 `reviseSchedule {taskId,reason,writes:[...]}`。AC 或检查契约需要改变时，用新票面先做 `previewPlan`，再走旧票作废与重派。原契约内的开发检查配方修订继续走下文的 `allowCheckRevision` 流程。

票面已被改写时，主控可以核对 `diagnoseTask` 给出的当前原始字节摘要，并执行返回的 `reviseSchedule {refreshSourceDigest:true,expectedSourceDigest,...}` 接续原票。确认只记录该版本的来源复核，原派发 AC、检查及已有交付证据继续生效。

## DSH 队列与投递恢复

`message` 先写入 LingFlow 收件箱，由空闲心跳送出提示。开工必读事项写入原票的 `brief`、`boundaries` 或 `stopConditions`，可独立处理的信息用 `message`，允许先发消息再派票。原绑定会话空闲且无后台作业时，桥接可将已确认的 LingFlow 排队提示同新票一起唤醒。成员从同一轮的 `inbox` 读取原消息与票据。空闲心跳也可恢复重连前已排队的唤醒。

`list` 角色卡显示 `pendingInputCount`、`lastTurnState` 和阻塞原因。DSH 空闲且无作业时可唤醒 LingFlow 输入，其他可识别输入在同一快照空闲满 6 秒后自动续接。待投递原票可随同一次唤醒送达。需要立刻续接时，复制 `redeliver {taskId}` 的 `unblock` 参数。确认误投时，复制同一回执的 `dropAction`，结果从 `list` 的 `lastInputDrop` 查阅。详细迁移步骤见 [MIGRATION.md](../MIGRATION.md)。

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

默认扫描 Git 跟踪的脏文件、票面写集和可见的未跟踪文件。归属扫描从未跟踪路径中过滤生成物，票面声明的路径仍进入检查。在 `execution.ownershipIgnores` 或 `execution.projects.<项目 ID>.ownershipIgnores` 中可用相对路径、`*` 和 `**/` 整体替换默认列表，不与默认规则合并。项目配置优先。`[]` 可关闭 LingFlow 的过滤，Git 自身忽略规则继续生效。`LingFlow ownership scan` 记录已核算指纹的文件数、缓存命中、Git 枚举与指纹耗时。`LingFlow ownership inventory` 在后台记录 Git 可见未跟踪总数、忽略数量和生效规则数 `patterns`。

默认过滤包括 `node_modules`、各层 `dist`、`.git`、`.hive/build-cache`、根目录的 `.scratch/` 和 `logs/`，以及 `**/dist.bak-*/`。需要核对这些目录内的文件时，在原票的 `writes` 或 `sources` 中显式声明。重绑结果的 `scannedFiles` 表示归属核算涉及的范围外脏文件数，包含缓存命中，不是整个仓库文件数；票面写集与冻结输入另行校验，已跟踪文件不会因噪声过滤而被隐藏。超时回执采用最近收到的扫描进度。

归属诊断中的 `ownershipIgnoreDetails` 显示归属过滤排除的路径和已声明、仍需扫描的 Git 忽略路径。并行票的归属有疑问时，先用 `diagnoseTask` 核对 `outsideOwnership`。主控停写后通过 `reviseSchedule` 带 `expectedHead` 和 `confirmForeignDirty` 确认具体文件、责任票 ID 及原始 SHA-256。文件再次变化会重新触发核对。

红阶段按准入时的实现文件指纹核对（`writes` 排除 `testWrites`）。`LINGFLOW_FINGERPRINT_EOL=normalize` 是默认值，只把 CRLF 变为 LF；`raw` 比较原始字节。测试、规划文档和产物证据仍按原始字节核对。未记录口径的旧基线或运行口径变化，不复用旧证据；由主控在停写后恢复并核对原实现，再用 `reviseSchedule {refreshBaseline:true}` 明确续接。

变更 `writes` 时按现行写集从可验证的原取红快照重算指纹，文件缺席也进入指纹。写集或读集调整会使原检查回执失效。无法核验原快照时，旧指纹保留在审计中，票据提示取红基线待确认。主控可停写后显式指定 `reviseSchedule {taskId,refreshBaseline:true,expectedHead,redBaselineHead,reason}`，其中两个提交参数均为当前 HEAD，原分支、干净暂存区与 HEAD 一致的实现范围须通过校验。随后仍由责任开发运行原票 red，取得真实断言失败。若原取红状态已不可恢复，可在主控确认归属后登记后继票。

`pruneOutside:true` 可单独用于持有冻结基线的排队、暂停、试用或执行中票。结合 `refreshBaseline:true` 时须满足刷新门槛。`prunedOutside:[]` 和 `pruneOutsideReason` 表示当前没有可证明已提交且已收口的票外基线条目。

在途期间不自行提交。成员用 `describeDrift` 核对提交差异，用 `report outcome=blocked` 交主控；不能自行重绑。主控显式重绑后，失效的红证据必须从原取红实现重跑，再检验新 HEAD 下的绿和完整检查。恢复原实现只操作冻结写集，不回退 Git HEAD。成员可用 `proposeOwnedDirty` 提报写集路径与原始字节 SHA-256；主控须用 `reviseSchedule` 的 `confirmOwnedDirty` 精确确认或 `rejectOwnedDirty:true` 拒绝。

主控在同一工作树严格串行推进多张实施票且具备 Git 提交授权时，逐票派发。前票 `summarize` 后提交可安全隔离的本票改动，核对提交和工作区状态后，再派下一票以新 HEAD 为基线。`verified` 前置可能在提交前放行，因此下一票在提交前保留于计划中。

## 新增测试与红证据

采用测试写集排除方案，无需先提交测试或新增 `testFirst` 字段。派发冻结路径和检查命令后，开发先编写 `testWrites`，保持实现文件与基线一致，运行 red；取得真实断言失败后修改实现，再运行 green 和 full。

无法自动定位取红快照时，`diagnoseTask` 把当前 HEAD 和准入 HEAD 列为核对线索。主控确认某个提交包含必要前置且尚未实现本票行为后，用 `reviseSchedule {taskId,realignRedBaseline:true,expectedHead,redBaselineHead,reason}` 续接。其中 `expectedHead` 是当前 HEAD，`redBaselineHead` 是主控选定的当前或历史提交。续接后由开发运行冻结 red 检查。

测试发生变化时，版本 2 的 `redProof` 绑定已准入的实现基线、实现侧写集和非写集输入。回执显式列出 `redProofScope` 与 `excludedTestWrites`。独立的 `redTestProof` 配对实际运行的测试，防止取得红证据后将断言替换为空跑；改测试后须在实现基线上重跑 red。测试未变化的票保留旧红指纹算法，已有有效旧格式回执也可以继续核验。

红阶段必须非零退出、命中冻结失败标记，并在完整日志中检测到 `AssertionError`、`ERR_ASSERTION`、`expect(...)` 或 `Expected:` / `Received:` 等断言标记，且 `failureOutputSeen=true`。`No tests found`、零测试、启动或语法错误、截断日志，以及仅打印自定义 `assertion:` 字符串均不予接纳。浏览器断言自身的等待超时仍可作为真实失败；测试进程或启动超时不能代替断言。旧回执若 `failureOutputSeen=false`，也必须重新取得有效红证据。

## 原票被后继票替代或退出调度

主控使用 `supersede {taskId,supersededBy,reason}`。用 `schema {command:"supersede"}` 查询允许的状态。旧票须无 queued/launching/uncertain 的检查。责任人仍在执行的票须先停写并 `yieldForSchedule`。写集存在暂存、未暂存、未跟踪或被 Git 忽略的在途改动时，释放回执显式给出 `handoff:{ticketKey,writes,ownedDirty,instruction}` 和 `nextAction:{command:"dispatchPlan",args:...}`。文件原样保留，由开发成员承接，主控不得接手实现或代为提交；工作树干净时省略 handoff。承接提案不等于新增授权，仍须 previewPlan、规划正文和归属准入校验。原基线已经漂移或冻结契约已不可满足，不妨碍在上述条件下替代旧票。

已交付票停在 `waiting_verification` 时，宿主须确认责任成员在交付后结束回合、心跳新鲜且当前空闲，排队输入、后台作业和未收口检查均已清空。主控可用 `diagnoseTask {taskId:承接票ID,supersedeConflict:原票ID}` 核对承接。仅终止旧票时使用 `abandonTask`。两条命令均记录主控、原因和停写凭据。

替代后旧票为 `superseded`，退出读集、写集、检查输入及共享资源的并发占用；保留原范围、冻结契约、基线、报告、审查、检查作业和日志，通过 `inspect {taskId}`、`checkEvidence {jobId}` 仍可读取。审计记录包含主控、原因、时间和后继票。后继票同项目且未收尾，原有等待票的依赖转向后继票；后继票移除对旧票的自等待并继承旧票的其他前置，verified/accepted 门槛不会降低，存在依赖环时整次操作被拒绝。旧票不因此成为“已验收”；后继票满足其余准入条件后立即进入调度。

仅需释放收尾票时，主控可用 `releaseSchedule {taskId,reason}`。暂停的实施票也可使用 `reviseSchedule {taskId,writes:[],reason}`，不要混传其他调度调整。两者执行相同停写和检查收口门禁，保存 `releasedScope` 快照并清空当前 writes；原票保持 paused/blocked，不再自动准入，其冻结检查也不再占用读集。`abandonTask` 同样提供在途改动承接回执。已释放票不能再次释放、confirmCommit 或 rebindCommittedWork；诊断发现原写集仍有改动时分类为 `controller-takeover-risk`，直接返回含 ownedDirty 的承接参数。

冲突回执带 `peerState`、`remedy` 和 `nextAction`。确认需承接时，用 `diagnoseTask` 核对实际写集冲突、停写证据及依赖，按回执提交 `supersede`。使用稳定 operationId 重试读取同一回执。

## 主控边界、证据回投与提交审计（F25/F26）

主控不得写业务代码、执行 red/green/full/regression、e2e 或 npm run build 等构建。只允许通过 `check` 提交冻结的 independent/controller 探针，时限仍为 60000ms。相同开发命令、相同入口追加参数、覆盖 full 全部 inputs 和 covers 的复制探针，以及通过 shell/子进程转发的包装探针均被拒绝。full 的全部 AC 覆盖门槛保持不变。

`diagnoseTask` 的证据阻塞返回 `nextAction.ownerRole` 与 `ownerId`。开发检查始终指向原票 developerId，与在线情况无关；主控只能执行 ownerRole=controller 的冻结探针。已交付票缺证时，`nextAction.returnToOwner` 给出主控可执行的 `rework {taskId,reason,evidence:[checkId]}`；`nextAction.command=check` 是责任开发成员的动作。仍在实施的票由原开发成员沿原票重跑，主控不会代跑。

`rework.evidence` 只接受本票冻结的非主控检查 id。`task.reworkEvidence` 保存待办；成员 inbox 逐条列出检查 id、上次 classification 和原因。指定检查通过新有效回执后逐项移除。记录本次返工要求的 revision，防止旧通过记录被复用来消除待办；未被指定且仍有效的其它证据可以复用。

`governance {limit:50}` 为只读命令，无需 operationId。主控只可查看本项目，工作台可按 projectId 选择项目。最多扫描最近50个提交，返回每个项目的 `{commit,ticketKey,files,at,kind}` 记录。未曾 summarize 的票，提交触及其 writes 时记录 in-flight-work-committed；释放后提交则记录 released-work-committed。新释放审计保存当时 Git HEAD，避免同一秒内提交与释放的先后关系被时间戳误判。结果表示范围和流程风险，不能据 Git 作者名证明是主控或开发者实际提交。

## uncertain 对账与构建前置超时（F27）

`reconcileCheck {jobId,evidence}` 保留工作台路径，并允许本项目主控使用。实际确认旧检查进程已经退出且资源可复用后填写 evidence。结果变为 interrupted，原回执保留，主控调用额外记录 reconciledBy=controller、reconciledById、reconciledAt。开发者和跨项目主控无权对账；uncertain 不会因此被视为通过。对账后原开发者可 yieldForSchedule，再按正常停写与检查收口门槛释放范围。不会自动丢弃 uncertain 作业或跳过确认。

构建前置失败也记录 preparation.elapsedMs、每步 elapsedMs 和 timedOut。前置步骤超时，或总超时时前置耗时达到总 timeoutMs 的80%，判为 preparation-timeout；回执不计红/绿证据。checkStatus {jobId} 与 diagnoseTask 的 nextAction 提供 dispatchPlan 承接提案，以及 before 数组中的对账、开发者交回和主控释放命令。建议预算依据实测下限及各步预算计算；超时步骤也须留余量，原票的冻结总时限和各步时限均不修改。主控探针不会突破60000ms。承接提案需核对规划与 ownedDirty，通过 previewPlan 后再执行派发。

previewPlan 对有 preSteps 且总 timeoutMs<300000 的检查给出“构建前置可能占满预算”warning；该提示不拒绝计划、不自动加时。构建与检查仍共享原票总预算。后继票的新时限必须由新规划冻结，超过一小时上限时须拆分构建或复用可核验产物。

上述命令只更新 LingFlow 状态和审计，不提交、回滚、修改项目文件或改写 Git 历史。写集尚有内容时保留现场，由主控先核对归属。累计验证批次的契约不会自动改写，涉及旧票的分组仍须主控沿原批次核对。

## 派发字段

| 字段 | 用法 |
| --- | --- |
| `requirementId` | 主控已登记的用户授权；读取 Hive 文档不等于执行授权。 |
| `sources.spec` / `sources.attempts` | 项目相对路径，分别指向规格和本轮跨票协调记录。没有额外协调可用一行非空说明。票内路线由责任开发在准入后决定。 |
| `sources.tickets` / `sources.ticketsDir` | 三选一：聚合票面路径、原票文件路径数组、包含原票 Markdown 的目录。多文件以 H1 票号定位；旧的 `lingflow-contract` 仍支持。 |
| `tickets[].key` / `developerId` | 稳定票号和本项目开发成员 ID。 |
| `writes` / `reads` | 显式项目相对路径；缺省或 `"from-ticket"` 可从 Hive 归属段派生。实施票空写集也尝试派生。歧义路径由主控补足；条件写入不自动纳入。背景阅读单列 `contextReads`。 |
| `after`、`resources` | 省略 `after` 时从票面派生 verified；显式数组（包括 `[]`）为准，未采用的票面前置记 warning。若必须等业务验收，用 accepted 显式声明。共享端口、数据库等资源必须如实声明。 |
| `verification.acceptance` / `testWrites` | 原票 AC 和允许写入的行为测试文件，可从已识别票面派生。测试路径仍须属于 writes；已有测试满足验证需求时，内容可以与基线完全一致，不强制修改。 |
| `verification.browserE2E` | 具名浏览器证据：`{file,title,reason,covers}`；也接受票根声明，不能两处冲突。兼容 Hive 票面显式用例标题与能唯一定位它的票号筛选。 |
| `verification.checks` | 新工单可在 `lingflow-checks` JSON 围栏填 `checks` 与 `browserE2E`，省略内联 verification。票面 AC 正文和 `lingflow-contract` 补足验收/测试写集。显式 verification 优先且有 warning，仍须满足契约。 |

`schema {command:"dispatchPlan",requirementId,spec,ticketsDir,attempts,developerIds?}` 用正式预检生成 `args` 与检查摘要。同一目录含旧票时，用 `tickets:[本轮票面路径]` 代替 `ticketsDir`。`state=valid` 的参数可原样派发；调整过的参数可用 `previewPlan` 检查。具名浏览器选择器可按 `violations[].repair` 修正，`requiresInput` 表示须核实实际用例、路径或检查配方。

参数生成优先推荐当前可接票的开发，显式 `developerIds` 优先。预检和派发可返回 `shared-resource-missing` 或 `dependency-shared-resource`，提示核对票面共享端口、派发资源及真实前置。依赖边和资源由主控确认。

如开发需要读实现才能定检查，在票面的 `lingflow-contract` 加 `developerChecks:true`。派发时保留全部 AC、`testWrites`、读写边界与资源，免审票仍由主控冻结独立探针。责任开发准入后先保持原实现，用 `registerChecks {taskId,checks,browserE2E?,resources?}` 登记真实红绿和完整检查。输入、构建产物与声明资源必须在批准范围内，扩围先交主控。通过登记后仍需取得真实红绿和候选检查证据。

修订冻结配方时，责任开发先 `yieldForSchedule`，主控再 `reviseSchedule {taskId,allowCheckRevision:true,reason}` 授权当前版本。责任开发用 `registerChecks {taskId,replace:true,reason,checks}` 登记完整的新配方。保留旧回执和版本审计，配方变化或被移除的检查回执失效。红配方变化时须恢复原取红实现，未变化且有效的红证据可继续使用。新配方继续覆盖冻结的 AC、`testWrites` 和独立探针。单次检查可在配方中声明 `resources`，持有资源的检查结束后释放，设备、端口和共享产物的冲突按作业协调。

开发检查尚待首次登记时，同一授权流程允许已停写的原开发完成登记。准备阶段超时且原票有可复用的等价检查历史时，诊断优先给出带 `preparationJobId` 的授权命令。其回执提供只调整超时预算的 `registerChecks` 参数。直接向 `reviseSchedule` 传 `verification` 会返回 `unsupported`。

`inspect`、`diagnoseTask` 与工作台票详情展示 `waitTimings`。前置、资源／范围及成员计时采用队列中程序实际观察的首要阻塞，`checkQueueMs` 按作业汇总，可与其他作业重叠。

`insertSchedule {taskId,after,reason}` 只修改 queued 票的依赖和调度版本，保留源文件、写集和已有基线。需要移除前置时确认业务不再依赖该结果；保留的 verified 边不能绕过证据门槛。已确认静默的 assigned 票可限量调整读集/前置或释放，正在运行、遥测不明、有排队输入或未完检查时不允许。

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
