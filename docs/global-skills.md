# 将已有全局工程技能适配到 LingFlow

这个兼容工具用于迁移旧的 Codex 全局工程技能。DSH 直接调用自身 `.dsh/skills`；本工具不会修改 DSH 技能，LingFlow 也不向角色注入仓库技能。安装不会重启会话、创建任务或派发责任。

先预览：

```powershell
node scripts/adapt-global-skills.mjs
```

默认写入目标为当前用户的 `.codex/skills`，可用 `--codex-root` 指定。包里的 `--dsh-root` 仅用于选择备份来源，不做适配或覆盖。已存在的显式调用策略和其他 UI 元数据保持原样。

确认预览后执行，备份 ZIP 必须是尚不存在的绝对路径：

```powershell
$backup = Join-Path ([Environment]::GetFolderPath('Desktop')) ('GlobalSkills-before-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
node scripts/adapt-global-skills.mjs --backup-zip $backup --apply
```

备份包含两边全局技能的完整文件树（排除 Git 元数据），以 `codex/` 与 `dsh/` 分目录，附 `BACKUP-MANIFEST.json`。逐文件校验 ZIP 内外 SHA-256 后才开始替换；链接目录、并发变化和已有同名备份会使操作停止。备份及本机安装回执不属于公共源码。

安装后再次预览应为 `changedFiles: 0`。新技能内容在原文件路径可直接读取；宿主若缓存技能目录、描述或已加载正文，需要刷新技能或在安全边界重新打开会话。工具不会强制重启正在工作的主控或成员，也不把磁盘验证当作当前模型已重新加载的证明。

如果需要恢复，用 ZIP 的对应目录按文件恢复原技能；先核对当前目录中的后续修改，保留 ZIP 和清单。新增的 `controller` 等文件可根据安装预览及备份清单辨认，不要把其他后来新增的技能一起删除。
