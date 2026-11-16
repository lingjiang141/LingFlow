import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportProject, projectRoot } from "../scripts/export-project.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

test("source release is complete, excludes private runtime material and refuses overwrites", t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lingflow-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "source");
  const manifest = exportProject(target);
  const files = new Set(manifest.files.map(f => f.file));
  for (const required of ["src/workflow.mjs", "desktop/main.cjs", "adapters/dsh/index.mjs", "package-lock.json",
    "LICENSE", "THIRD_PARTY_NOTICES.md", ".github/workflows/ci.yml", "scripts/build-portable.mjs", "tests/release.test.mjs"])
    assert.ok(files.has(required), required);
  for (const file of files) {
    assert.doesNotMatch(file, /(^|\/)(\.git|node_modules|\.validation|ui\/assets)(\/|$)|\.sqlite|\.log$/);
    assert.doesNotMatch(file, /scripts\/(live-dsh-driver|verify-pipeline)|docs\/(cache-investigation|pending-fixes)/);
  }
  for (const entry of manifest.files) {
    const bytes = readFileSync(path.join(target, entry.file));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
  }
  assert.ok(existsSync(path.join(target, "RELEASE-MANIFEST.json")));
  const sentinel = path.join(target, "local-work.txt");
  writeFileSync(sentinel, "preserve");
  assert.throws(() => exportProject(target), /already exists/);
  assert.equal(readFileSync(sentinel, "utf8"), "preserve");
  assert.throws(() => exportProject(path.join(projectRoot, "release-test")), /outside/);
});

test("DSH registration previews without changes, backs up before apply, and refuses a duplicate", t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lingflow-registration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const setup = path.join(dir, ".validation/dsh-setup");
  mkdirSync(setup, { recursive: true });
  const profile = path.join(dir, "cordis.patch.yml"), original = "# existing plugins\n- insert: []\n";
  writeFileSync(profile, original);
  writeFileSync(path.join(setup, "cordis.patch.yml"), "- insert:\n    - id: lingflow-dsh\n");
  const run = (...args) => spawnSync(process.execPath, [path.join(projectRoot, "scripts/register-dsh.mjs"), "--profile", profile, ...args],
    { cwd: dir, encoding: "utf8", windowsHide: true });
  const preview = run();
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(readFileSync(profile, "utf8"), original);
  const apply = run("--apply");
  assert.equal(apply.status, 0, apply.stderr);
  const receipt = JSON.parse(readFileSync(path.join(setup, "registration-receipt.json")));
  assert.equal(readFileSync(receipt.backup, "utf8"), original);
  const installed = readFileSync(profile, "utf8");
  assert.ok(installed.startsWith(original));
  assert.notEqual(run("--apply").status, 0);
  assert.equal(readFileSync(profile, "utf8"), installed);
});
