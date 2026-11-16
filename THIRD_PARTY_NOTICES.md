# 第三方声明

根目录的 MIT 许可证适用于 LingFlow 自编代码，不重新许可第三方代码、形象或动画。

## 桌宠素材

素材来自 [hunmer/aboutme-pets](https://github.com/hunmer/aboutme-pets/tree/ee29ca4abb489e9257f41ab889a1db115323a267)。完整署名与来源见 [desktop/pet-assets/ATTRIBUTION.md](desktop/pet-assets/ATTRIBUTION.md)，随包的原始声明必须保留。按需下载的动作同样适用这些限制。

- DSH 形象/素材来自 PC2005-cloud/dsh-pet：非商业使用、公开二创须署名；该仓库代码的 MIT 声明不替代素材使用限制。见目录内 `DSH-NOTICE.txt` 与 `DSH-SOURCE-upstream.txt`。
- Claude、GPT、Gemini、Grok 动作来自 aboutme-pets，基础形象来自 lokicorvus/crosspet，按 CC BY-NC-SA 4.0 使用（署名、非商业、相同方式共享）。

因此，包含这些素材的完整桌面发行包不能被当作全部采用 MIT 的商业素材包。需要商业分发时，替换素材或另行取得权利人的许可。

## Electron 与依赖

Electron 及 npm 依赖各自遵守原许可证。源码用 `package-lock.json` 固定依赖版本；Windows 便携包保留 Electron 自带的 `LICENSE` 与 `LICENSES.chromium.html`。DSH 是用户自行安装的外部宿主，本项目不随包提供 DSH。
