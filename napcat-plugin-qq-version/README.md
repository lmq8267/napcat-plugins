# NapCat QQ 版本查询与更新助手 🕷️

一个为 NapCat 量身定制的 QQ 版本管理插件，旨在让您的 QQ 运行环境始终保持在官方推荐的最佳状态。

---

## 🌟 核心功能

- **智能版本查重**: 自动比对当前运行的 QQ 环境与 NapCat 官方推荐版本，精确到 Build 号。
- **一键全自动安装 (Linux)**: 深度集成 Linux 权限管理，支持 Rootless (~/Napcat) 与系统级 (/opt/QQ) 两种模式的一键覆盖更新。
- **全平台下载引导**: 针对 Windows 及 macOS 提供最精准的推荐安装包下载，支持手动安装引导。
- **极简 WebUI 管理**: 采用毛玻璃质感的现代单页面设计，所有信息一目了然，拒绝冗余操作。
- **自动版本配置修补**: 在 Linux 更新后自动更新 `versions/config.json`，确保 QQ 能立刻识别新版本。

## 📁 目录概览

```bash
napcat-plugin-qq-version/
├── src/
│   ├── index.ts              # 插件生命周期入口 & WebUI 路由注册
│   ├── services/
│   │   ├── github-service.ts # 智能包匹配与 GitHub Release 解析逻辑
│   │   ├── install-service.ts# Linux 自动安装、解压与配置修补服务
│   │   └── api-service.ts    # WebUI 无认证接口分发
│   ├── webui/                # 基于 React + TailwindCSS 的极简前端
│   └── core/state.ts         # 插件全局状态单例
└── .github/workflows/        # 自动化 CI/CD (支持 AI 生成 Release Note)
```

## 🛠️ 安装与构建

### 1. 编译插件
```bash
# 安装依赖
pnpm install

# 完整构建 (前端构建 + 后端打包)
pnpm run build
```

### 2. 部署建议
将生成的 `dist/` 文件夹整体移动至 NapCat 的 `plugins/` 目录下，随后在 NapCat WebUI 的插件管理中即可看到 **QQ 版本管理** 入口。

## 🐧 针对 Linux 用户的特别说明 (一键更新)

本插件支持在 WebUI 环境下对 Linux QQ 进行一键升级，操作完成后：
1.  **Rootless 模式**: 插件会自动修改 `package.json` 的入口点，确保 NapCat 注入逻辑不会丢失。
2.  **系统配置**: 插件会自动更新用户目录下的版本配置信息。
3.  **生效方式**: 安装完成后仅需 **重启 NapCat** 即可。

## 📄 开源说明

本项目基于 MIT 协议开源。欢迎通过 GitHub Issues 提交反馈或建议。

---
*Created with ❤️ by AQiaoYo*
