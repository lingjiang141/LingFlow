import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { startServer } from "../src/server.mjs";
import { createAppearanceLibrary } from "../src/appearance.mjs";

// 真实的 1×1 透明 PNG；外观素材只校验魔数，字节完整性另行比对。
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const PNG = Buffer.from(PNG_BASE64, "base64");

const sandbox = (prefix) => {
  mkdirSync(".validation", { recursive: true });
  return mkdtempSync(path.resolve(".validation", prefix));
};

async function startApp(t) {
  const dataDir = sandbox("appearance-");
  const assetRoot = path.join(dataDir, "assets");
  const app = await startServer({ dataDir, port: 0, assetRoot });
  t.after(() => app.close());
  const base = "http://127.0.0.1:" + app.port;
  const post = (route, token, body = {}, headers = {}) =>
    fetch(base + route, {
      method: "POST",
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const appearance = (token, body) =>
    post("/api/ui/appearance", token, body);
  return { dataDir, assetRoot, app, base, post, appearance };
}

test("导入的图片复制到项目文件夹内，列表、读取、删除闭环可用", async (t) => {
  const { assetRoot, app, base, appearance } = await startApp(t);

  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await fetch(base + "/app.js")).status, 200);
  assert.equal((await fetch(base + "/style.css")).status, 200);
  // 静态资源仍然只认 ui/ 根目录、白名单扩展名。
  assert.equal((await fetch(base + "/nonexistent.js")).status, 404);
  assert.equal((await fetch(base + "/package.json")).status, 404);
  assert.equal((await fetch(base + "/src/server.mjs")).status, 404);

  const imported = await appearance(app.uiToken, {
    action: "import",
    name: "  测试\n背景  ",
    data: PNG_BASE64,
  });
  assert.equal(imported.status, 200);
  const { asset } = await imported.json();
  assert.match(asset.id, /^[a-f0-9]{24}$/);
  assert.equal(asset.name, "测试背景");
  assert.equal(asset.ext, "png");
  assert.equal(asset.size, PNG.length);
  assert.equal(asset.url, "/assets/" + asset.id + ".png");

  // 字节确实落在项目文件夹里，而不是保存一条源文件路径。
  const stored = path.join(assetRoot, asset.id + ".png");
  assert.deepEqual(readFileSync(stored), PNG);

  const image = await fetch(base + asset.url);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(
    image.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);

  // data URL 前缀同样接受，且同一字节天然幂等。
  const prefixed = await appearance(app.uiToken, {
    action: "import",
    name: "再来一张",
    data: "data:image/png;base64," + PNG_BASE64,
  });
  assert.equal(prefixed.status, 200);
  assert.equal((await prefixed.json()).asset.id, asset.id);

  const listed = await (await appearance(app.uiToken, { action: "list" })).json();
  assert.equal(listed.assets.length, 1);
  assert.equal(listed.assets[0].id, asset.id);
  assert.deepEqual(readdirSync(assetRoot).sort(), [asset.id + ".png", "library.json"]);

  const index = JSON.parse(
    readFileSync(path.join(assetRoot, "library.json"), "utf8"),
  );
  assert.equal(index.version, 1);
  assert.equal(index.items.length, 1);
  assert.equal(index.items[0].id, asset.id);

  // 非图片、错误鉴权与未知动作都走既有 400/401 语义。
  const notImage = await appearance(app.uiToken, {
    action: "import",
    name: "x",
    data: Buffer.from("hello").toString("base64"),
  });
  assert.equal(notImage.status, 400);
  assert.match((await notImage.json()).error, /不支持的图片格式/);
  assert.equal((await appearance("", { action: "list" })).status, 401);
  assert.equal((await appearance("wrong", { action: "list" })).status, 401);
  const unknown = await appearance(app.uiToken, { action: "nope" });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /未知动作/);

  // 目录穿越与不存在的素材一律 404，且不会把服务打崩。
  assert.equal((await fetch(base + "/assets/../package.json")).status, 404);
  assert.equal(
    (await fetch(base + "/assets/%2e%2e%2fpackage.json")).status,
    404,
  );
  assert.equal((await fetch(base + "/assets/notreal.png")).status, 404);
  assert.equal((await fetch(base + "/assets/library.json")).status, 404);
  assert.equal((await fetch(base + "/")).status, 200);

  // 删除后文件、索引与列表一起清空；重复删除报「图片不存在」。
  const removed = await appearance(app.uiToken, {
    action: "remove",
    id: asset.id,
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { removed: true });
  assert.equal((await fetch(base + asset.url)).status, 404);
  assert.deepEqual(
    (await (await appearance(app.uiToken, { action: "list" })).json()).assets,
    [],
  );
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(assetRoot, "library.json"), "utf8")).items,
    [],
  );
  assert.equal(
    (await appearance(app.uiToken, { action: "remove", id: asset.id })).status,
    400,
  );
  assert.equal(
    (await appearance(app.uiToken, { action: "remove", id: "../package" }))
      .status,
    400,
  );
});

test("外观导入的请求体上限放宽到 24 MiB，可容纳较大图片的 base64", async (t) => {
  const { assetRoot, app, appearance } = await startApp(t);
  const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(300 * 1024, 0x5a)]);
  const response = await appearance(app.uiToken, {
    action: "import",
    name: "大图",
    data: big.toString("base64"),
  });
  assert.equal(response.status, 200);
  const { asset } = await response.json();
  assert.equal(asset.size, big.length);
  // 请求体已超过其他路由的 256 KiB 上限，说明该路由确实单独放宽。
  assert.ok(big.toString("base64").length > 256 * 1024);
  assert.deepEqual(readFileSync(path.join(assetRoot, asset.id + ".png")), big);
});

test("同一毫秒导入的图片仍按导入顺序倒序，重新打开和重复导入保持顺序", t => {
  t.mock.timers.enable({apis:['Date'],now:1700000000000});
  const root=path.join(sandbox('appearance-tied-clock-'),'assets');
  const library=createAppearanceLibrary(root);
  const first=library.importImage({name:'first',data:Buffer.concat([PNG,Buffer.from('a')]).toString('base64')}).asset;
  const second=library.importImage({name:'second',data:Buffer.concat([PNG,Buffer.from('b')]).toString('base64')}).asset;
  const third=library.importImage({name:'third',data:Buffer.concat([PNG,Buffer.from('c')]).toString('base64')}).asset;
  assert.equal(first.addedAt,second.addedAt);assert.equal(second.addedAt,third.addedAt);
  const expected=[third.id,second.id,first.id];
  assert.deepEqual(library.list().assets.map(a=>a.id),expected);
  library.importImage({name:'repeat first',data:Buffer.concat([PNG,Buffer.from('a')]).toString('base64')});
  assert.deepEqual(createAppearanceLibrary(root).list().assets.map(a=>a.id),expected);
});

test("素材库自带格式嗅探、尺寸上限、失效条目剔除与倒序", async () => {
  const dataDir = sandbox("appearance-lib-");
  const root = path.join(dataDir, "assets");
  const library = createAppearanceLibrary(root);
  assert.deepEqual(library.list(), { assets: [] });
  assert.deepEqual(createAppearanceLibrary(path.join(dataDir, "none")).list(), {
    assets: [],
  });

  const formats = [
    ["gif", Buffer.from("GIF89a-fixture")],
    ["jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01])],
    [
      "webp",
      Buffer.concat([
        Buffer.from("RIFF"),
        Buffer.alloc(4),
        Buffer.from("WEBP"),
        Buffer.from("x"),
      ]),
    ],
    ["bmp", Buffer.from([0x42, 0x4d, 0x01])],
  ];
  for (const [ext, bytes] of formats) {
    const { asset } = library.importImage({
      name: ext,
      data: bytes.toString("base64"),
    });
    assert.equal(asset.ext, ext);
    assert.equal(asset.size, bytes.length);
    assert.equal(asset.url, "/assets/" + asset.id + "." + ext);
    assert.ok(library.mimeFor(asset.id + "." + ext).startsWith("image/"));
    assert.deepEqual(readFileSync(path.join(root, asset.id + "." + ext)), bytes);
  }

  assert.throws(
    () =>
      library.importImage({
        name: "x",
        data: Buffer.from("hello").toString("base64"),
      }),
    /不支持的图片格式/,
  );
  assert.throws(() => library.importImage({ name: "x", data: "" }), /缺少图片数据/);
  const oversize = Buffer.concat([
    PNG.subarray(0, 8),
    Buffer.alloc(16 * 1024 * 1024 + 1),
  ]);
  assert.throws(
    () => library.importImage({ name: "大", data: oversize.toString("base64") }),
    /图片过大（上限 16 MB）/,
  );

  // 空名称回落到默认名称，控制字符被清掉。
  const unnamed = library.importImage({ name: " \u0000 ", data: PNG_BASE64 });
  assert.equal(unnamed.asset.name, "背景图片");

  // 新增的在前：addedAt 倒序。
  const first = library.importImage({
    name: "第一张",
    data: Buffer.concat([PNG, Buffer.from("a")]).toString("base64"),
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = library.importImage({
    name: "第二张",
    data: Buffer.concat([PNG, Buffer.from("b")]).toString("base64"),
  });
  const listed = library.list().assets;
  assert.equal(listed[0].id, second.asset.id);
  assert.equal(listed[1].id, first.asset.id);
  assert.equal(listed.length, formats.length + 3);

  // 索引写入是原子的：目录里不会留下临时文件。
  assert.equal(
    readdirSync(root).some((file) => file.endsWith(".tmp")),
    false,
  );

  // 文件被手工删掉或索引损坏时，按空库/剔除处理而不是抛错。
  rmSync(path.join(root, second.asset.id + ".png"), { force: true });
  assert.equal(
    library.list().assets.some((asset) => asset.id === second.asset.id),
    false,
  );
  writeFileSync(path.join(root, "library.json"), "{ 损坏的索引");
  assert.deepEqual(library.list(), { assets: [] });
  rmSync(path.join(root, "library.json"), { force: true });
  assert.deepEqual(library.list(), { assets: [] });
});
