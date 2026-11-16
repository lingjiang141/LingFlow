# LingFlow 侧边栏面板（lingflow-panel）

DSH 侧边栏里的 LingFlow 入口。它和独立窗口**共用同一个本地服务**（默认 `127.0.0.1:47831`）、同一份数据（`%LOCALAPPDATA%\LingFlow`）和同一条投递链，因此两个入口同时打开也不会重复派单或重复唤醒。

**侧边栏里显示的就是独立窗口那一套界面本身**：面板不自绘、不复制，而是把服务对外提供的同一个页面（`ui/index.html` 及其样式/脚本）嵌进 DSH 的视觉区域。所以两个入口界面永远一致，改动 `ui/` 之后侧边栏下一次打开/刷新就是新的，不需要为侧边栏单独改一遍界面。

需求确认与派单仍然在 DSH 主控会话里用 `lingflow_team` 完成；侧边栏是同一服务的另一个视图。

## 组成

| 层 | 文件 | 作用 | 改动后如何生效 |
| --- | --- | --- | --- |
| Host 半部 | `panel/index.js` → `../src/panel-host.mjs` | 在 DSH 的 webServer 上注册同源路由 `/lingflow-panel/api/*`；`/frame` 用 302 把框架页指向共享服务，令牌只出现在 Location 头里 | 重载 DSH（关闭再打开） |
| Client 半部 | `panel/client.js` | `sidebar.panellist` 图标 + `main` 面板：顶部一条工具栏，下面把上面那个页面嵌进来（默认 `<iframe>`，12 秒没加载就自动换桌面壳的 `<webview>`） | 重载 DSH（client 包按内容修订号在启动时登记，改文件后必须重启才生效） |
| 界面 | `../ui/` | 独立窗口与侧边栏共用的唯一一套界面 | 面板重新打开/刷新即生效；无需重装、无需重启 |
| 服务 | `../src/server.mjs` 等 | 工作流、投递、巡检、后台检查 | 没有任何角色启用时由面板自动重载；否则重启独立窗口（或 `npm run service` 前先退出窗口） |

**自动同步**：面板以 `link:E:/LingFlow/panel` 装进 DSH profile，不是拷贝。

- 改 `ui/`（界面）：面板重新点开或刷新就拿到新版本，**不需要重装、不需要重启 DSH、也不会动其他插件**。
- 改 `panel/client.js`（工具栏/嵌入逻辑本身）：需要重载 DSH——DSH 在启动时按内容修订号登记 client 包，进程内不会重新读这个文件。
- 改 `src/`（服务层）：状态接口比较 `src/`、`ui/`、`panel/`、`adapters/` 下最新 mtime 与服务启动时间。发现新代码且**没有任何角色启用**时，下一次轮询会**自动重载服务**（换一个刚读到新代码的进程），面板里的页面随之重挂；**有角色启用时不自动重载**——重启会把角色恢复为关闭状态，不能替用户打断正在进行的责任。这种时候点工具栏的「重启服务」（服务由侧边栏拉起时可用），或退出侧边栏在独立窗口/命令行里重启。

## 面板工具栏

LingFlow 自己的界面里没有的东西都放在页面上方那条工具栏里——这样做正是为了让下面嵌进来的页面**和独立窗口一模一样**，不必在页面里塞侧边栏专用按钮：

| 控件 | 作用 |
| --- | --- |
| 状态灯 + 文案 | 绿=已连上共享服务（并显示端口）；黄=服务未连接；红=界面加载失败 |
| 刷新 | 重新加载嵌入的页面（不改服务、不动角色） |
| 重启服务 | 重启**侧边栏自己拉起的**共享服务；服务由独立窗口托管时按钮变灰，提示去窗口里重启 |
| 独立窗口 | 打开 LingFlow 桌面窗口（复用同一个服务，两个入口不会分叉） |
| 诊断 | 展开连接详情：渲染方式（网页框架/桌面视图）与一键切换、`/frame` 地址、服务 pid/端口/模式、代码修订号、桌面桥是否可用、**日志文件路径**、最近 20 条客户端事件、「复制诊断」 |

**白屏怎么查**：面板把每一步和每一次失败都上报给宿主，写进 `%LOCALAPPDATA%\LingFlow\panel-client.log`；每个路由调用（含框架页请求的状态码、`Sec-Fetch-Dest`、UA）写进 `panel-access.log`。两个文件都是 JSON 行，`panel-client.log` 里的 `mount` 是面板挂载的第一行（其中的 `ancestor` 是父页面 origin），`frame-loaded` / `frame-timeout` / `frame-failed` 说明嵌入结果；`panel-access.log` 里有没有 `"label":"frame"` 则说明框架页到底有没有被请求——这是「被父页 CSP 挡掉」和「页面自己没渲染」的唯一区分办法。

**已知的一个原因**（2026-11 修掉）：DSH 桌面壳的页面不是 http 页面，而是特权自定义协议 `dsh-app://app/`（`protocol.registerSchemesAsPrivileged` 里的 `standard+secure` 方案）。服务端 CSP 的 `frame-ancestors` 一旦只列 http 回环来源，Chromium 就会拒绝这个祖先把页面放进 frame——而 iframe 仍然会触发 `load` 事件，于是表现为「白屏 + 日志里一切正常」。所以默认值里带上了 `dsh-app:`；换别的宿主（比如自建 Electron 壳）时用 `LINGFLOW_FRAME_ANCESTORS` 覆盖。

## 嵌不进去怎么办

面板默认用普通 `<iframe>` 嵌 `/frame`（确定性最好）。12 秒内没有加载完成的信号就自动换成桌面壳的 `<webview>`（和 DSH 自带浏览器同一套租约握手）；两种都失败才显示错误卡片和「重试」。渲染方式在「诊断」里可以手动切换，选择会被记住。

- 嵌入失败时先确认服务在跑：看工具栏状态灯，或 `npm run service`；再点「刷新」。
- 还是白屏就点「诊断」→「复制诊断」，或把上面两个日志文件发给维护者。
- 工具栏不想要？它是 `panel/client.js` 里的 `Toolbar`，删掉不影响页面嵌入。

## 安装

前提：Node.js 24、DSH 已首次运行过（profile 目录存在）、LingFlow 依赖已安装（`npm ci`）。

```powershell
cd E:\LingFlow

# 1) 预览：只算 hash 和差异，不写任何文件
node scripts/panel-install.mjs

# 2) 应用：写 profile package.json（dependencies + dsh.profile.bundles）+ 一个 node_modules 链接
node scripts/panel-install.mjs --apply

# 3) 关闭并重新打开 DSH，侧边栏出现 ◈ LingFlow 图标
```

- 备份：每次写入前把 profile `package.json` 备份到 `E:\LingFlow\.validation\panel\package.json.<时间>.bak`，回执写在 `.validation\panel\install-receipt.json`。
- 脚本**只改** `dependencies["lingflow-panel"]` 与 `dsh.profile.bundles` 两个字段，不写 `cordis.patch.yml`，不重排其他插件顺序，不碰其他插件目录。
- 如果你的 profile 里 `node_modules/lingflow-panel` 是实目录（pnpm 拷贝安装），脚本会停下并提示；确认要替换再加 `--force`。
- 指向别的 profile：`node scripts/panel-install.mjs --profile "C:\Users\<你>\.dsh\profiles\desktop" --apply`。

## 更新

```powershell
cd E:\LingFlow
git pull            # 或直接在编辑器里改
node scripts/panel-install.mjs --apply   # 只有 profile 配置漂移时才需要重跑
```

- `ui/`、`panel/client.js` 更新：刷新 DSH 页面。
- 服务层更新：没有启用角色时面板自动重载；有启用角色时退出侧边栏后用独立窗口/命令行重启。
- `panel/index.js`（Host 半部）更新：需要重载 DSH。
- 如果之后在 profile 里跑过 `pnpm install`，本地 link 可能被清掉，重跑 `--apply` 即可恢复。

## 卸载

```powershell
cd E:\LingFlow
node scripts/panel-install.mjs --remove --apply   # 预览可去掉 --apply
```

卸载只移除 profile 里的依赖项、`dsh.profile.bundles` 条目和那条链接。LingFlow 的项目数据、票、报告、独立窗口和 DSH 适配器都保留；重载 DSH 后侧边栏入口消失。

## 运行时行为

- **只有一个服务**：面板第一次请求会先探活共享端口。已经有服务（独立窗口托管的，或之前由面板拉起的）就直接附着；没有才拉起一个脱离窗口的 `node src/server.mjs` 子进程，并把 pid 记到 `%LOCALAPPDATA%\LingFlow\panel-service.json`。所以两个入口永远是同一个工作流循环。
- **页面只有一个版本**：面板把 `/lingflow-panel/api/frame` 交给框架页，宿主 302 到 `http://127.0.0.1:<port>/#<uiToken>`。页面从 `location.hash` 取令牌后立刻抹掉 hash 并转存 sessionStorage，所以你看到的和独立窗口是同一份 HTML/CSS/JS，令牌也没有进渲染层。
- **自动同步代码**：状态接口比较代码 mtime 与服务启动时间。发现新代码且当前没有启用角色时，自动重启自己拉起的服务（`code.autoReloaded: true`），面板检测到 pid 变化就重挂页面；有启用角色时不会自动重启。由独立窗口托管的服务永远不会被侧边栏自动重载或重启。
- **令牌**：UI 令牌和桥接令牌统一存在 `%LOCALAPPDATA%\LingFlow\config.json`（0600）。旧版本升级时会把缺失的 `uiToken` 补写进去，不轮换已有令牌，因此 DSH 适配器不受影响。
- **服务版本不一致**：如果端口上运行的是本版本之前启动的旧服务（不带侧边栏令牌），`/frame` 会回 503 并在面板里写明原因；退出旧窗口后再启动即可，不会自己杀进程。
- **写路由防跨站**：DSH 的插件路由不受登录保护、只监听回环，所以面板的写路由要求 `application/json` 且拒绝 `Sec-Fetch-Site: cross-site`，`/frame` 只接受本机连接。`/restart`、`/snapshot`、`/call` 仍保留给脚本和测试用，界面上没有入口。

## 验证

- `npm run test:panel`：宿主路由、`/frame` 302、CSRF 防护、令牌不出渲染层、渲染层日志落盘、`/open`；以及 client 半部的形状——只注册两个槽、零 `dangerouslySetInnerHTML`、走 `/frame` 而不是直连 `/api/ui`、工具栏按钮齐全、默认 iframe + 超时升级、**首次渲染不抛异常**（抛异常在 DSH 里就是一个白屏）。
- `npm run test:panel-e2e`：隔离项目和隔离端口上跑两个入口的完整闭环，并断言 `/frame` 的 302、页面与 `/style.css` `/cards.css` `/theme.js` `/app.js` `/appearance.js` 都能取到。
- `npm run test:panel-visual`：用隔离 Electron 实例在相同视口里截两张图——A 是「仿 DSH 宿主页里的 iframe → `/frame`」，B 是「直接打开同一页面」。像素差需 ≤ 0.1%，且标题、DOM 节点数、关键元素几何位置与计算样式、全部 `--lf-*` 变量逐项相等；产物在 `.validation/panel-visual/<时间>/`（`compare.png` 左右并排、`diff-heatmap.png` 差异像素）。加 `--size 380x820` 会在默认视口之外再跑一趟侧边栏宽度，产物带 `-narrow` 后缀（`compare-narrow.png` 等），结果并入同一份 `visual.json` 的 `narrow` 字段——这是「窄到只有半个屏幕时界面还对不对」的证据。工具栏不在比对范围里：比对的是被嵌入的那张页面，工具栏属于面板外壳。

## 排错

| 现象 | 处理 |
| --- | --- |
| 侧边栏没有图标 | 确认 `node scripts/panel-install.mjs` 显示 profile 已包含 `lingflow-panel`；改完必须关闭并重开 DSH |
| 打开面板是**白屏** | 先看重载 DSH 后有没有工具栏：有工具栏说明面板挂载正常、只是嵌入没成；看 `%LOCALAPPDATA%\LingFlow\panel-client.log` 的最后几行（`frame-loaded` / `frame-timeout` / `frame-failed`）与 `panel-access.log` 里有没有 `"label":"frame"`。12 秒后会自动换渲染方式；也可以在「诊断」里手动切换 |
| 面板一直显示「正在连接」 | 端口上有旧版服务时 `/frame` 回 503 并写明原因，退出独立窗口后重试；或改 `config.json` 的 port 后重启两个入口 |
| 面板显示「界面加载失败」 | 两种嵌入都失败。先用 `npm run service` 或独立窗口确认服务在跑，再点「刷新」；或用工具栏的「独立窗口」 |
| 「重启服务」按钮是灰的 | 服务由独立窗口托管，侧边栏不杀别人的进程。到独立窗口里重启，或先关掉窗口 |
| 面板报「令牌不匹配」 | 数据目录被换过。确认 `LINGFLOW_DATA_DIR` / `%LOCALAPPDATA%\LingFlow` 后重启服务 |
| 独立窗口里「选择目录…」不可用 | 服务由侧边栏先拉起时没有原生对话框，手动输入绝对路径即可；或先开独立窗口 |
| 改了 `ui/` 侧边栏没变 | 关闭再点开一次侧边栏（页面是重新请求的），或点工具栏「刷新」 |
| 改了 `panel/client.js` 没变 | 必须重载 DSH：client 包在启动时按内容修订号登记 |
| DSH 启动日志里 `lingflow-panel` 被跳过 | 检查 `node scripts/panel-install.mjs` 的 preview，确认 `dsh.profile.bundles` 里含该包名且链接存在 |
