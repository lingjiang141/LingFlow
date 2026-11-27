import { spawn } from "node:child_process";
import { statSync } from "node:fs";

/**
 * Open the project's root directory in the OS file manager or a CMD/terminal window.
 */
export function defaultOpenProjectTool(root, tool) {
  let stat;
  try {
    stat = statSync(root);
  } catch {
    throw Error("项目目录不存在");
  }
  if (!stat.isDirectory()) throw Error("项目路径不是有效目录");
  const launch = (cmd, args) => {
    const child = spawn(cmd, args, { cwd: root, detached: true, windowsHide: false, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  };
  if (tool === "folder") {
    if (process.platform === "win32") launch("explorer.exe", [root]);
    else if (process.platform === "darwin") launch("open", [root]);
    else launch("xdg-open", [root]);
    return { ok: true };
  }
  if (tool === "cmd") {
    if (process.platform === "win32") launch("cmd.exe", ["/c", "start", "", "/D", root, "cmd.exe"]);
    else if (process.platform === "darwin") launch("open", ["-a", "Terminal", root]);
    else launch("x-terminal-emulator", ["--working-directory=" + root]);
    return { ok: true };
  }
  throw Error("未知项目工具");
}
