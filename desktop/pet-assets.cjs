const { readFile, mkdir, writeFile, rename, readdir, stat, unlink } = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const bundledRoot = path.join(__dirname, "pet-assets");
const catalog = JSON.parse(readFileSync(path.join(bundledRoot, "catalog.json"), "utf8"));
const checksum = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

function createPetAssets(cacheRoot) {
  const pending = new Map(), unavailable = new Map();
  async function local(file, action) {
    try {
      const bytes = await readFile(file);
      return bytes.length === action.size && checksum(bytes) === action.sha ? bytes : null;
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async function prune() {
    const files = await readdir(cacheRoot);
    const entries = await Promise.all(files.filter(file => /^[a-f0-9]{40}\.webp$/.test(file)).map(async file => ({ file, ...await stat(path.join(cacheRoot, file)) })));
    let bytes = entries.reduce((sum, file) => sum + file.size, 0);
    for (const file of entries.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (bytes <= 256 * 1024 * 1024) break;
      await unlink(path.join(cacheRoot, file.file)); bytes -= file.size;
    }
  }
  async function load(character, action) {
    const name = action.sha + ".webp";
    for (const directory of [bundledRoot, cacheRoot]) {
      const bytes = await local(path.join(directory, name), action);
      if (bytes) return bytes;
    }
    if ((unavailable.get(action.sha) ?? 0) > Date.now()) throw Error("动画暂不可用");
    const source = `https://raw.githubusercontent.com/hunmer/aboutme-pets/${catalog.revision}/` + action.source.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(source, { signal: AbortSignal.timeout(12000), redirect: "error" });
    if (!response.ok) throw Error("动画下载失败");
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 8 * 1024 * 1024) throw Error("动画文件超过大小限制");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== action.size || checksum(bytes) !== action.sha) throw Error("动画校验失败");
    await mkdir(cacheRoot, { recursive: true });
    const temporary = path.join(cacheRoot, name + ".tmp");
    await writeFile(temporary, bytes);
    await rename(temporary, path.join(cacheRoot, name));
    void prune().catch(() => {});
    return bytes;
  }
  return {
    catalog,
    async image(characterId, actionId) {
      const character = catalog.characters.find(character => character.id === characterId);
      const action = character?.animations.find(action => action.id === actionId);
      if (!action) throw Error("未知桌宠动画");
      if (!pending.has(action.sha)) pending.set(action.sha, load(character, action).catch(error => {
        unavailable.set(action.sha, Date.now() + 60000); throw error;
      }).finally(() => pending.delete(action.sha)));
      return { bytes: await pending.get(action.sha), animation: action };
    },
  };
}
module.exports = { createPetAssets };
