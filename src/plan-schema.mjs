import { browserStageRules } from "./verification-policy.mjs";

export const checkShape = {
  id: "focused", stage: "green", argv: ["node", "verify.cjs"], inputs: ["test/example.test.cjs"], covers: ["AC-1"],
};
export const planSchema = {
  required: ["requirementId", "sources", "tickets"],
  requirementId: "requirement ID created by approve",
  sources: { required: ["spec", "attempts"], oneOf: ["tickets", "ticketsDir"],
    spec: "spec.md", tickets: "tickets.md | string[]", ticketsDir: "issues", attempts: "planned-attempts.md" },
  tickets: [{
    required: ["key", "developerId"],
    key: "R35-01", developerId: "assigned developer ID",
    title: "from-ticket or explicit title", description: "from-ticket or explicit instructions",
    brief: "optional objective", boundaries: "optional constraints", stopConditions: "optional stop conditions",
    risk: "low | medium | high", riskReason: "optional reason", readOnly: false, developerChecks: false,
    writes: "from-ticket | string[]", reads: "from-ticket | string[]", contextReads: [],
    resources: [], ownedDirty: [], after: [{ ticket: "R35-00", stage: "verified | accepted" }],
    verification: {
      acceptance: [{ id: "AC-1", text: "Observable criterion" }], testWrites: ["test/example.test.cjs"],
      browserE2E: [{ file: "e2e/example.spec.ts", title: "literal title", reason: "why a real browser is needed", covers: ["AC-1"] }],
      checks: [{ ...checkShape, timeoutMs: 15000, expectedExit: 0, expectedOutput: "optional success marker",
        failureOutput: "optional assertion marker", deriveRed: false, redExpectedExit: 1, redExpectedOutput: "optional real red marker" }],
    },
  }],
  optionalTicketRootAlias: "browserE2E -> verification.browserE2E",
  developerChecks: "lingflow-contract 可声明 developerChecks:true。派发冻结 AC、testWrites、读写、资源和适用主控探针；责任开发在原实现未变时用 registerChecks 冻结真实检查。",
  materialize: { command: "schema", args: { command: "dispatchPlan", requirementId: "approved requirement ID",
    spec: "spec.md", ticketsDir: "issues", attempts: "planned-attempts.md" },
    oneOf: ["ticketsDir（本轮新票目录）", "tickets（本轮具体票面路径数组）"],
    optional: ["developerIds（按票号指定成员）"], result: "state=valid 时原样提交 args；票面 checks 由服务读取，不必在参数中重复" },
  ticketChecks: { fence: "lingflow-checks", fields: ["ticket", "checks", "browserE2E"],
    precedence: "显式 verification 优先；其余从票面契约、AC 正文与检查围栏读取，仍执行完整校验" },
  batches: [{ key: "release", tickets: ["R35-01","R35-02"], argv: ["node","verify.cjs","batch"],
    inputs: ["verify.cjs"], covers: [{ ticket: "R35-01", acceptance: ["AC-1"] },{ ticket: "R35-02", acceptance: ["AC-1"] }] }],
  stages: ["red", "green", "full", "regression", "independent", "controller"],
  redGreenKey: ["argv (ordered)", "inputs (normalized set)", "covers (set)"],
  browserChecks: {
    stages: browserStageRules,
    argvNormalization: "stringify and trim CLI arguments; canonicalize equivalent regex escapes without decoding JSON twice",
    diagnostics: "argv, inputs and covers are validated separately; argv mismatch prints complete received and expected argv",
    committedTests: "testWrites may equal baseline contents; red and green use the same frozen tests, with only implementation changing",
    testWrites: "must remain within writes; declaration permits test edits but does not require them",
  },
  independentTimeoutMs: 60000,
  controllerBoundary: {stages:['independent','controller'],execution:'check only; no business edits, e2e, build, red/green/full/regression',
    isolation:'argv and runner entry point must differ from developer checks; no full inputs+covers replica or child-process/shell wrapper',
    evidenceRecovery:'rework {taskId,reason,evidence:[checkId]} to original developerId'},
  preparation: { requiredArtifacts: ["apps/web/dist"], preSteps: [{argv:["npm","run","build"],outputs:["apps/web/dist"],timeoutMs:120000}],
    warning:'有 preSteps 且总 timeoutMs < 300000 时提示构建前置可能占满预算；不自动延长或改写冻结检查',
    rule: "显式冻结构建命令；outputs 不得覆盖 writes/inputs，inputs 须包含构建配置及源码；先构建后检查，总时限不扩大，回执记录日志与产物 hash" },
};

export function violation(path, message, expected, remedy, replacement) {
  return { path, message, expected, remedy,
    repair: replacement ?? { path, value: null, requiresInput: true } };
}

export function invalidPlan(violations, warnings = []) {
  const message = violations.map((item) => item.path + "：" + item.message).join("；");
  return Object.assign(Error(message), { verificationCode: "contract-invalid", violations, warnings });
}

export function unknownFields(value, keys, prefix, warnings) {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value).filter((key) => !keys.includes(key)))
    warnings.push({ path: prefix + "." + key, message: "未知字段，不参与冻结契约" });
}
