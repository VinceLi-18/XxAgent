# native/

[English](README.md) | 中文

作为私有 XxAgent 应用一部分维护的 native 源码。[`landlock-run/` workspace](landlock-run/README.md) 负责 harness 使用的 Landlock 自限后执行 launcher，包括其架构、由三个内部 package 组成的 workspace 家族、平台支持、开发工作流和[私有产物验证](landlock-run/docs/release.md)。

## Workspace 与应用边界

`landlock-run/` 及其包属于仓库根 pnpm workspace，并共用根锁文件。开发和 CI 中的 harness 消费方直接使用当前 workspace 的入口包，因此启动器约定变更与消费方更新可以在同一个改动中落地并一起测试。

主仓库的 `Landlock Run` 工作流为每个受支持架构构建并测试，然后演练应用使用的 package payload。入口包继续将平台包声明为 optional dependency，因此 pnpm 只会暂存与 host 操作系统和 CPU 匹配的包。任何工作流都不会把该家族发布到 npm。
