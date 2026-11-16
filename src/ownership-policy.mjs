const defaults = Object.freeze([
  "**/node_modules/", "**/dist/", "**/.git/", "/.hive/build-cache/", "/.hive/release/",
  "/.hive/user-assets/", "*.tar.gz", "*.png",
  "/.hive/handoffs/**/bundles/", "/.hive/handoffs/**/baseline/", "/.hive/handoffs/**/implementation-events/",
  "/.hive/handoffs/**/check-*.json", "/.hive/handoffs/**/baseline-manifest.json",
  "/.hive/handoffs/**/gate-cache-*.json", "/.hive/handoffs/**/bundle-cache-*.json",
  "/.hive/handoffs/**/plans/*.json", "/.hive/jobs/",
  "/.hive/handoffs/**/implementation.json",
]);

function compile(pattern) {
  if (typeof pattern !== "string" || !pattern || pattern.length > 240 ||
      !/^[\p{L}\p{N}\p{M}_. /*-]+$/u.test(pattern) || pattern.split("/").some((part) => [".", ".."].includes(part)))
    throw Error("ownershipIgnores 仅接受相对目录或 Git 通配规则，如 **/dist/ 或 *.png");
  const directory = pattern.endsWith("/");
  const glob = pattern.replace(/^\//, "").replace(/\/$/, "");
  if (!glob) throw Error("ownershipIgnores 不能忽略工作区根目录");
  const match = glob.replace(/\*\*\/|\*|[.]/g, (part) => ({ "**/": "(?:[^/]+/)*", "*": "[^/]*", ".": "\\." })[part]);
  return new RegExp((pattern.startsWith("/") || glob.includes("/") ? "^" : "(?:^|/)") + match + (directory ? "/" : "(?:/|$)"),
    process.platform === "win32" ? "i" : "");
}

export function ownershipPolicy(patterns = defaults) {
  if (!Array.isArray(patterns) || patterns.length > 100) throw Error("ownershipIgnores 必须为路径规则数组");
  const matchers = patterns.map(compile);
  return { patterns, version: JSON.stringify(patterns), ignores: (file) => matchers.some((pattern) => pattern.test(file)) };
}
