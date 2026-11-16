import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const defaultDataDir = () =>
  process.env.LINGFLOW_DATA_DIR ||
  path.join(process.env.LOCALAPPDATA || process.env.HOME, "LingFlow");

const token = () => randomBytes(32).toString("hex");

/**
 * Read the one config every LingFlow entrance shares.
 *
 * The desktop window, the sidebar panel host and the DSH adapter all attach to
 * the same local service, so the UI token can no longer live only in the memory
 * of whichever process happened to bind the port first: it is persisted next to
 * the bridge token (0600). Tokens are repaired in place, never rotated, so an
 * already-running instance keeps working with the file it wrote.
 */
export function readConfig(dataDir = defaultDataDir()) {
  mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(dataDir, "config.json");
  if (!existsSync(configPath)) {
    try {
      writeFileSync(
        configPath,
        JSON.stringify(
          { port: 47831, bridgeToken: token(), uiToken: token() },
          null,
          2,
        ),
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      // Another entrance won the creation race; its file is authoritative.
      if (error.code !== "EEXIST") throw error;
    }
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw Error("LingFlow 配置无法解析：" + configPath + "（" + error.message + "）");
  }
  config.port =
    Number.isInteger(config.port) && config.port > 0 && config.port < 65536
      ? config.port
      : 47831;
  if (typeof config.bridgeToken !== "string" || config.bridgeToken.length < 32)
    throw Error("LingFlow 配置缺少 bridgeToken，请保留现场并检查：" + configPath);
  if (typeof config.uiToken !== "string" || config.uiToken.length < 32) {
    config.uiToken = token();
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
  return { ...config, path: configPath };
}
