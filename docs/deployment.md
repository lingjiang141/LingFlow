# 安装、打包与 GitHub 发布

## 源码安装（Windows x64）

需要 Node.js 24+、npm，以及用于成员协作的 DSH。解压源码或 clone 到可写目录，在项目根目录运行：

```powershell
npm ci
npm run check
npm test
npm start
```

若 npm 禁止依赖安装脚本，显式运行 `node node_modules/electron/install.js` 后再启动。Electron 下载需要网络；版本由锁文件固定。启动桌面窗口无需账号密钥，成员模型与供应商在 DSH 内配置。首次使用创建项目、团队和角色绑定，不包含作者的任何推进记录。

源码的 `npm run service` 可只启动本地服务。默认监听 `127.0.0.1:47831`，仅供本机使用，不是公网网站服务。独立窗口、侧边栏与适配器共用同一数据目录，见 [数据说明](data-storage.md)。

## Windows 安装版和便携版

在 [GitHub Releases](https://github.com/lingjiang141/LingFlow/releases/latest) 的 Assets 中双击下载好的 `LingFlow-<版本>-win-x64-Setup.exe`。安装程序使用当前用户权限，默认把程序放在 `%LOCALAPPDATA%\Programs\LingFlow`，并在开始菜单建立入口。升级时先从托盘完全退出 LingFlow。卸载可在 Windows 的「已安装的应用」中进行，默认运行数据独立保存在 `%LOCALAPPDATA%\LingFlow`。

从 [GitHub Releases](https://github.com/lingjiang141/LingFlow/releases/latest) 的 Assets 中下载名称带 `win-x64` 的 ZIP。页面中的 `Source code (zip)` 和仓库绿色“代码 → 下载 ZIP”都是源码包。

便携版需要将整个文件夹解压到可写位置，再运行 `Start-LingFlow.cmd` 或 `LingFlow.exe`。请保留 `resources/`、DLL 与许可证文件。两个 Windows 包均未签名，已包含 Electron，桌面运行无需另外安装 Node.js。团队协作须先自行安装 DSH，接入脚本需要 Node.js 24+。

应用代码在 `resources/app/`，下列源码命令需在此目录运行。服务的界面和检查会真实读写用户选择的项目，请只绑定受信任的本机团队。

内置技能注入默认停用。按[配套技能与分轮规划](planning-workflow.md) 将需要的技能放入宿主技能目录。

## 接入 DSH

先启动并退出一次 LingFlow 创建本机配置。在 DSH 安装目录找到实际 `dsh-tools/lib/index.js`，传入绝对路径：

```powershell
node scripts/prepare-dsh.mjs "D:\YourDSH\node_modules\dsh-tools\lib\index.js"
node scripts/register-dsh.mjs --profile "D:\YourDSHProfile\cordis.patch.yml"
# 核对 .validation/dsh-setup/registration-preview.json 后再应用
node scripts/register-dsh.mjs --profile "D:\YourDSHProfile\cordis.patch.yml" --apply
```

`--profile` 可省略，默认使用用户目录 `.dsh/profiles/desktop/cordis.patch.yml`。脚本仅追加插件项，应用前备份原文件；已有 LingFlow 注册时拒绝重复添加。不要把生成的本机配置纳入 Git。重启 DSH 后在成员会话使用 `lingflow_connect`，再在 LingFlow 确认绑定、开启角色。工具链针对当前 DSH 的适配接口验证，其他版本需核对兼容性。

可选侧边栏：`node scripts/panel-install.mjs` 先预览，`node scripts/panel-install.mjs --apply` 应用；可用 `--profile <DSH-profile目录>` 指定配置。面板通过链接使用当前代码，不要移动已接入的应用目录。

## 在本机生成干净发行物

```powershell
npm ci
node scripts/export-project.mjs E:\Releases\LingFlow-source
node scripts/build-portable.mjs E:\Releases\LingFlow-win-x64
npm run build:installer -- E:\Releases\LingFlow-win-x64 E:\Releases\LingFlow-0.3.0-win-x64-Setup.exe
```

目标必须是源码外的新目录，脚本拒绝覆盖。导出只包含明确允许的产品代码、测试、技能、通用文档与第三方声明；排除 `.git`、依赖、真实数据、`.validation`、自定义背景与本机诊断文档。`RELEASE-MANIFEST.json` 列出源码文件、大小和 SHA-256。便携构建在 Windows x64 上使用锁定版 Electron，按 `resources/app` 目录方式封装，后台 worker 保持为真实文件。

构建 Setup 需要 [NSIS 3](https://nsis.sourceforge.io/Download)，本版使用 3.13。将 `makensis.exe` 加入 PATH，或在命令末尾传入编译器绝对路径。Setup 使用同版本便携目录作为载荷。

## 稍后推送 GitHub

公开仓库为 `https://github.com/lingjiang141/LingFlow`，默认分支 `main`。按根目录 `AGENTS.md` 核对授权及远程更新，用干净导出的源码同步发布仓库，并在推送后核对远程提交。

GitHub Actions 在 Windows 上运行语法检查、自动化测试和桌面冒烟检查，并生成源码和便携版 artifact。发布时，以验证通过的提交建立版本标签和 GitHub Release，上传 Windows Setup、便携 ZIP、技能 ZIP 和 SHA-256 清单。

自编代码采用 [MIT](../LICENSE)；桌宠素材另有非商业限制，见 [第三方声明](../THIRD_PARTY_NOTICES.md)。打包时保留这些文件。
