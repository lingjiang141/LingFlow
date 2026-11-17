import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Imported appearance images live inside the project folder, not as links to
 * wherever the user picked them from: the bytes are copied next to the UI so a
 * background keeps working after the source file is moved or deleted.
 */
export const defaultAssetRoot = fileURLToPath(
  new URL("../ui/assets/", import.meta.url),
);

const MAX_BYTES = 16 * 1024 * 1024;
const INDEX_FILE = "library.json";
const DEFAULT_NAME = "背景图片";
const MAX_NAME = 120;
const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};
const FILE_PATTERN = /^([a-f0-9]{24})\.(png|jpg|gif|webp|bmp)$/;
const ID_PATTERN = /^[a-f0-9]{24}$/;

/** Sniff the real format from the bytes so a renamed .png cannot smuggle HTML. */
function sniffExt(bytes) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "jpg";
  if (bytes.length >= 6) {
    const head = bytes.subarray(0, 6).toString("latin1");
    if (head === "GIF87a" || head === "GIF89a") return "gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "webp";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  return null;
}

/** Strip control characters, trim, cap the length and never land on an empty name. */
function cleanName(name) {
  const text = typeof name === "string" ? name : "";
  const stripped = text.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!stripped) return DEFAULT_NAME;
  return Array.from(stripped).slice(0, MAX_NAME).join("");
}

function normalizeItem(item) {
  return {
    id: item.id,
    name: cleanName(item.name),
    ext: item.ext,
    size: Number.isFinite(item.size) ? item.size : 0,
    addedAt: typeof item.addedAt === "string" ? item.addedAt : "",
    url: "/assets/" + item.id + "." + item.ext,
  };
}

function timeOf(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * One library per asset root. The index (`library.json`) is only a cache of
 * names and timestamps; the image files themselves are the source of truth, and
 * an unreadable index simply means "empty library" instead of a crash.
 */
export function createAppearanceLibrary(root = defaultAssetRoot) {
  const base = path.resolve(root);
  const indexPath = path.join(base, INDEX_FILE);

  const readItems = () => {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(indexPath, "utf8"));
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items))
      return [];
    return parsed.items.filter(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.id === "string" &&
        ID_PATTERN.test(item.id) &&
        typeof item.ext === "string" &&
        Object.hasOwn(MIME, item.ext),
    );
  };

  const writeItems = (items) => {
    mkdirSync(base, { recursive: true });
    const temporary =
      indexPath + "." + process.pid + "-" + Date.now().toString(36) + ".tmp";
    writeFileSync(temporary, JSON.stringify({ version: 1, items }, null, 2));
    renameSync(temporary, indexPath);
  };

  const fileFor = (fileName) => {
    if (typeof fileName !== "string") return null;
    const match = FILE_PATTERN.exec(fileName);
    if (!match) return null;
    const file = path.join(base, fileName);
    try {
      if (!statSync(file).isFile()) return null;
    } catch {
      return null;
    }
    return file;
  };

  const mimeFor = (fileName) => {
    const match = typeof fileName === "string" ? FILE_PATTERN.exec(fileName) : null;
    return (match && MIME[match[2]]) || "application/octet-stream";
  };

  const list = () => ({
    assets: readItems()
      .filter((item) => fileFor(item.id + "." + item.ext))
      .map((item, index) => ({ asset: normalizeItem(item), at: timeOf(item.addedAt), index }))
      // Imports append to the index; timestamp ties retain newest-first order.
      .sort((a, b) => b.at - a.at || b.index - a.index)
      .map((entry) => entry.asset),
  });

  const importImage = ({ name, data } = {}) => {
    if (typeof data !== "string" || !data) throw Error("缺少图片数据");
    const payload = data.replace(/^data:[^,]*;base64,/i, "");
    const bytes = Buffer.from(payload, "base64");
    if (bytes.length > MAX_BYTES) throw Error("图片过大（上限 16 MB）");
    const ext = sniffExt(bytes);
    if (!ext) throw Error("不支持的图片格式（支持 PNG、JPEG、GIF、WebP、BMP）");
    const id = createHash("sha256").update(bytes).digest("hex").slice(0, 24);
    const items = readItems();
    const existing = items.find((item) => item.id === id && item.ext === ext);
    const file = path.join(base, id + "." + ext);
    // Same bytes are already stored: keep the first file and the first metadata,
    // so re-importing a background never duplicates the list entry.
    if (!existsSync(file)) {
      mkdirSync(base, { recursive: true });
      writeFileSync(file, bytes);
    }
    if (existing) return { asset: normalizeItem(existing) };
    const created = {
      id,
      name: cleanName(name),
      ext,
      size: bytes.length,
      addedAt: new Date().toISOString(),
    };
    const next = items.filter((item) => item.id !== id);
    next.push(created);
    writeItems(next);
    return { asset: normalizeItem(created) };
  };

  const remove = (id) => {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw Error("图片不存在");
    const items = readItems();
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) throw Error("图片不存在");
    const [item] = items.splice(index, 1);
    try {
      rmSync(path.join(base, item.id + "." + item.ext), { force: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    writeItems(items);
    return { removed: true };
  };

  return { list, importImage, remove, fileFor, mimeFor };
}
