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

## Windows 便携版

将整个 `LingFlow-win-x64` 文件夹解压到可写位置，双击 `Start-LingFlow.cmd` 或 `LingFlow.exe`。必须保留 `resources/`、DLL 与许可证文件，不能只复制 exe。桌面运行时已包含 Electron，不需要额外安装 Node；DSH 仍需自行安装，运行下面的接入脚本需 Node.js 24+。这是未签名的便携包，不是 Setup 安装器，当前验证平台为 Windows x64。

应用代码在 `resources/app/`，下列源码命令需在此目录运行。服务的界面和检查会真实读写用户选择的项目，请只绑定受信任的本机团队。

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
```

目标必须是源码外的新目录，脚本拒绝覆盖。导出只包含明确允许的产品代码、测试、技能、通用文档与第三方声明；排除 `.git`、依赖、真实数据、`.validation`、自定义背景与本机诊断文档。`RELEASE-MANIFEST.json` 列出源码文件、大小和 SHA-256。便携构建在 Windows x64 上使用锁定版 Electron，按 `resources/app` 目录方式封装，后台 worker 保持为真实文件。

## 稍后推送 GitHub

建议把**干净导出的源码目录**作为新的发布仓库，保留开发仓库及历史不动。给出目标仓库地址后，再为这个目录配置远程并推送；现在不需要令牌或远程地址。不要直接上传整个开发目录，也不要上传真实数据备份。

已随源码提供 GitHub Actions：提交或手动运行时，在 Windows 上执行安装、语法检查、自动化测试和桌面冒烟检查，生成源码与便携版 artifact。它不自动创建 GitHub Release。通过验证后，可以手动建立版本标签和 Release，上传两个压缩包与 SHA-256 清单。标签/发布应对应审查后的提交。

自编代码采用 [MIT](../LICENSE)；桌宠素材另有非商业限制，见 [第三方声明](../THIRD_PARTY_NOTICES.md)。打包时保留这些文件。
