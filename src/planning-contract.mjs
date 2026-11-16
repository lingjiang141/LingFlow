import { coversPath, scopePaths } from "./files.mjs";

const fields = ["requiredWrites", "requiredTestWrites", "requiredAcceptance"];
const stableKey = (value) => typeof value === "string" && /^[\w.-]{1,80}$/.test(value);
const fail = (message) => {
  throw Object.assign(Error(message), { verificationCode: "contract-invalid" });
};

export function readTicketContracts(document) {
  const contracts = new Map();
  let block = null;
  let fence = null;
  for (const line of document.text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})\s*(.*)$/.exec(line);
    if (fence && marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2]) {
      if (block) {
        let input;
        try { input = JSON.parse(block.join("\n")); } catch {
          fail(`${document.file}：lingflow-contract 不是有效 JSON`);
        }
        const { ticket } = input ?? {};
        if (!stableKey(ticket) || fields.some((name) => !Array.isArray(input[name])) ||
            Object.keys(input).some((name) => name !== "ticket" && !fields.includes(name)))
          fail(`${document.file}：lingflow-contract 须填写 ticket、requiredWrites、requiredTestWrites、requiredAcceptance`);
        if (contracts.has(ticket)) fail(`${document.file}：票 ${ticket} 的 lingflow-contract 重复`);
        if (!input.requiredAcceptance.length || input.requiredAcceptance.some((key) => !stableKey(key)))
          fail(`${document.file}：票 ${ticket} 的 requiredAcceptance 须列出稳定 AC 编号`);
        try {
          contracts.set(ticket, {
            source: document.file,
            requiredWrites: scopePaths(input.requiredWrites),
            requiredTestWrites: scopePaths(input.requiredTestWrites),
            requiredAcceptance: [...new Set(input.requiredAcceptance)],
          });
        } catch (error) {
          fail(`${document.file}：票 ${ticket} 的契约路径无效：${error.message}`);
        }
      }
      fence = block = null;
    } else if (fence) {
      if (block) block.push(line);
    } else if (marker) {
      fence = marker[1];
      if (marker[2] === "lingflow-contract") block = [];
    }
  }
  if (block) fail(`${document.file}：lingflow-contract 缺少结束围栏`);
  return contracts;
}

export function assertTicketContract(task, contract = task.ticketContract) {
  if (!contract) return;
  const { source, requiredWrites, requiredTestWrites, requiredAcceptance } = contract;
  if (!task.verification) fail(`${source}：票 ${task.ticketKey} 有实施契约，不能作为只读票派发`);
  const missing = [];
  const { testWrites, checks, acceptance } = task.verification;
  for (const file of [...new Set([...requiredWrites, ...requiredTestWrites])])
    if (!coversPath(task.writes, file)) missing.push(`writes 缺少 ${file}`);
  for (const file of requiredTestWrites) {
    if (!coversPath(testWrites, file)) missing.push(`verification.testWrites 缺少 ${file}`);
    if (!checks.some((check) => check.stage === "full" && coversPath(check.inputs, file)))
      missing.push(`${file} 未纳入 full 检查的 inputs`);
  }
  for (const id of requiredAcceptance) {
    if (!acceptance.some((ac) => ac.id === id)) missing.push(`验收条款缺少 ${id}`);
    else if (!checks.some((check) => check.stage === "full" && check.covers.includes(id)))
      missing.push(`${id} 未绑定 full 检查`);
  }
  if (missing.length) fail(`${source} / ${task.ticketKey}：${missing.join("；")}`);
}
