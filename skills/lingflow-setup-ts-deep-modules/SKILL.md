---
name: lingflow-setup-ts-deep-modules
description: "为采用 TypeScript 的 LingFlow 目标项目设计模块入口和依赖边界检查。"
---

# TypeScript 模块边界

先确认目标确实使用 TypeScript，读包管理器、公开入口、路径别名和已有检查。以实际模块为例提出只通过公开入口访问的规则，以及内部实现允许的依赖。

在批准写集内配置规则和现有检查命令。验证一条合法导入和一条越界导入能被区分。处理必要的依赖或命令变更后提交证据。
