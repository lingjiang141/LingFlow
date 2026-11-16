# 数据位置与迁移

LingFlow 的安装目录保存程序、依赖和随包素材；实际项目推进记录与安装目录分离。

默认数据目录是 `%LOCALAPPDATA%\LingFlow`。`workflow.sqlite` 保存任务、需求、候选、操作和事件；`checks/` 保存检查回执和日志；`desktop/` 保存 Electron 缓存和按需下载的桌宠；`config.json` 含本机访问令牌。以上内容均不应上传到公开仓库。`.validation/` 是源码目录下的隔离测试产物，也不属于安装包。

## 已有数据迁移到其他盘

1. 关闭团队角色，等待后台检查结束并对账；退出 LingFlow 和托管它的本地服务。脚本会检查监听端口、角色与作业，不自动终止任何进程。
2. 安装 Node.js 24+，在源码根目录运行（目标目录必须尚不存在）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-data.ps1 -Destination E:\LingFlowData
```

脚本核对数据库完整性，复制并逐文件校验 SHA-256；在目标盘的 `LingFlowData-backups/<时间>/` 再保留一份备份。验证后用 Windows 目录联接将原路径指向新目录，再移除已核验的原副本。已有绝对日志路径、DSH 配置与本机令牌仍然有效。迁移回执在备份目录旁，重复指定同一目标会返回 `already-migrated`。

如出现错误，保留源、目标、备份与 `.moving-*` 现场，不要自行覆盖或清空目录。不要删除或移动联接的 E 盘目标。迁移备份本身含真实项目和令牌，不能随发行包上传。

## 新安装指定数据盘

可在**第一次启动前**为桌面程序、本地服务、DSH 配置共同指定 `LINGFLOW_DATA_DIR`，例如 `E:\LingFlowData`。所有入口必须指向同一目录。这个变量只选择目录，不会搬走旧数据；已有安装优先用上述迁移脚本保留旧路径。

更换程序版本时保留数据目录即可。测试脚本使用单独的 `.validation/`，不应指向真实数据。
