import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

// Pin the catalogue and each download to a reviewed upstream revision.
const revision = "ee29ca4abb489e9257f41ab889a1db115323a267";
const origin = `https://raw.githubusercontent.com/hunmer/aboutme-pets/${revision}/`;
const destination = path.resolve("desktop/pet-assets");
const characters = process.argv.slice(2);
if (!characters.length || characters.some(id => !["dsh", "claude", "gpt", "gemini", "grok"].includes(id)))
  throw Error("Specify characters: dsh claude gpt gemini grok");
async function get(file, json = true) {
  const response = await fetch(origin + file.split("/").map(encodeURIComponent).join("/"), { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`${file}: HTTP ${response.status}`);
  return json ? response.json() : Buffer.from(await response.arrayBuffer());
}
const response = await fetch(`https://api.github.com/repos/hunmer/aboutme-pets/git/trees/${revision}?recursive=1`);
if (!response.ok) throw Error("Cannot read upstream asset index");
const tree = await response.json();
if (tree.truncated) throw Error("Incomplete asset index");
const files = new Map(tree.tree.map(file => [file.path, file]));
await mkdir(destination, { recursive: true });
let catalog = { revision, source: "https://github.com/hunmer/aboutme-pets", characters: [] };
try { catalog = JSON.parse(await readFile(path.join(destination, "catalog.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (catalog.revision !== revision) throw Error("Do not merge catalogues from different revisions");
for (const id of characters) {
  const [actions, manifest] = await Promise.all([get(`pets/${id}/actions.json`), get(`pets/${id}/manifest.json`)]);
  const animations = actions.animations.map(action => {
    const source = `pets/${id}/${action.sources.webp}`;
    const entry = files.get(source);
    if (!entry || !source.startsWith(`pets/${id}/spritesheet/`) || !source.endsWith(".webp")) throw Error("Invalid asset path");
    return { id: action.id, name: action.name, source, sha: entry.sha, size: entry.size, ...action.spritesheet };
  });
  const coding = animations.find(action => action.id === "写代码") ?? animations.find(action => action.name.includes("写代码"));
  const idle = animations.find(action => action.id === manifest.idleAnimationId) ?? animations.find(action => /待机|呼吸/.test(action.name));
  if (!coding || !idle) throw Error(`${id}: missing coding or idle animation`);
  const bundled = [...new Set([coding.id, idle.id, ...["东张西望", "超大伸懒腰"].filter(name => animations.some(action => action.id === name))])];
  for (const action of animations.filter(action => bundled.includes(action.id))) {
    const bytes = await get(action.source, false);
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (sha !== action.sha) throw Error("Asset checksum mismatch: " + action.source);
    await writeFile(path.join(destination, action.sha + ".webp"), bytes);
  }
  const character = { id, name: id === "dsh" ? "DSH" : ({ claude: "Claude", gpt: "GPT", gemini: "Gemini", grok: "Grok" })[id], coding: coding.id, idle: idle.id, bundled, animations };
  catalog.characters = [...catalog.characters.filter(character => character.id !== id), character];
  console.log(`${character.name}: ${animations.length} animations; coding=${coding.id}; bundled=${bundled.length}`);
}
await writeFile(path.join(destination, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
for (const name of ["NOTICE.txt", "SOURCE-upstream.txt", "LICENSE-assets.txt", "LICENSE-code.txt"])
  await writeFile(path.join(destination, "DSH-" + name), await get(`pets/dsh/${name}`, false));
