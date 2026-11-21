import path from "node:path";
import { inspectionMetadata } from "./controller-notices.mjs";
import { parentPort, workerData } from "node:worker_threads";
import { Store } from "./store.mjs";
import { Workflow } from "./workflow.mjs";
import { startCheckRunner } from "./check-runner.mjs";
import { withCommandProgress } from "./execution-policy.mjs";

const { dataDir, readOnly, execution } = workerData;
const store = new Store(path.join(dataDir, "workflow.sqlite"), { readOnly });
const workflow = new Workflow(store, { readOnly, execution });
let stopChecks, patrolTimer;
if (!readOnly) {
  stopChecks = startCheckRunner(workflow, dataDir);
  patrolTimer = setInterval(() => {
    try {
      workflow.patrolTick();
    } catch (error) {
      console.error("LingFlow 巡检：", error.message);
    }
  }, 5000);
}

parentPort.on("message", ({ id, method, args, trackProgress, timeoutMs }) => {
  try {
    let result;
    if (method === "close") {
      stopChecks?.();
      clearInterval(patrolTimer);
      store.close();
      parentPort.postMessage({ id });
      parentPort.close();
      return;
    } else {
      if (trackProgress) parentPort.postMessage({ id, progress: { phase: "command" } });
      result = withCommandProgress(trackProgress ? (progress) => parentPort.postMessage({ id, progress }) : undefined,
        () => workflow[method](...args), timeoutMs);
    }
    parentPort.postMessage({ id, result, inspection: result?.[inspectionMetadata] });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message, verificationCode: error.verificationCode, violations: error.violations,
      nextAction: error.nextAction, unownedWrites: error.unownedWrites, blockers: error.blockers });
  }
});
parentPort.postMessage({ ready: true });
