import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("./check-worker.mjs", import.meta.url));
function read(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

export function startCheckRunner(workflow, dataDir) {
  const directory = path.resolve(dataDir, "checks");
  const running = new Map();
  const rootFor = (id) => path.join(directory, id);
  function launch(job) {
    const root = rootFor(job.id);
    mkdirSync(root, { recursive: true });
    const electron = !!process.versions.electron;
    writeFileSync(
      path.join(root, "request.json"),
      JSON.stringify({ ...job, electron }),
      { flag: "wx" },
    );
    const env = { ...process.env };
    if (electron) env.ELECTRON_RUN_AS_NODE = "1";
    const child = spawn(process.execPath, [worker, root], {
      env,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    running.set(job.id, child);
    child.once("error", () => running.delete(job.id));
    child.once("exit", () => running.delete(job.id));
    child.unref();
  }

  function poll() {
    for (const job of workflow.activeChecks()) {
      const root = rootFor(job.id);
      try {
        if (job.state === "queued") {
          const claim = workflow.claimCheck(job.id);
          if (claim) launch(claim);
          continue;
        }
        const result = read(path.join(root, "result.json"));
        if (result) {
          workflow.finishCheck(job.id, result, path.join(root, "output.txt"));
          continue;
        }
        const owner = read(path.join(root, "running.json"));
        const elapsed = Date.now() - job.startedAt;
        const aliveEnough =
          elapsed <= job.check.timeoutMs + 30000 &&
          (running.has(job.id) || (owner && alive(owner.pid)));
        if (!aliveEnough && elapsed > 10000)
          workflow.finishCheck(job.id, { uncertain: true }, null);
      } catch (error) {
        // A missing or unreadable receipt is never evidence to retry execution.
        if (Date.now() - (job.startedAt ?? Date.now()) > 10000)
          workflow.finishCheck(
            job.id,
            { uncertain: true, launchError: error.message },
            null,
          );
      }
    }
  }
  const timer = setInterval(poll, 350);
  timer.unref();
  return () => clearInterval(timer);
}
