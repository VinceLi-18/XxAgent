# XxAgent

[English](README.md) | 中文

XxAgent 是私有发行的智能体应用，在一个仓库中集成 DeepSeek Harness 与 XAgent 业务源码。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 开发者预览

DeepSeek Harness 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 发行

一个授权的仓库 revision 构成发行单元。JavaScript workspace、vendored Cordis 源码、native 启动器、Python runtime、FastAPI 服务、worker 与部署配置都是应用内部组件，不发布到 npm 或 PyPI。

继承的 `@deepseek-ai/*` 与 XAgent 自有的 `@xagent/*` 包名保留为内部模块标识。每个内部依赖都从当前 workspace 解析，不依赖外部 DSH 包发行版。

## 从源码运行

安装仓库支持的 Node.js 与 pnpm 版本，然后运行：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm dsh web
```

该命令会启动 Web UI，默认地址为 `http://127.0.0.1:3080`。详见 [Web UI 指南](docs/user/guide/index.md)。

完整 Business 部署还需要 [API 服务指南](services/api/README.md)说明的 FastAPI、PostgreSQL、MinIO、ClamAV、worker 与 embedding 服务。

## 参与贡献

授权贡献者应遵循 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

请先阅读[开发指南](docs/development.md)与[架构文档](docs/architecture.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
