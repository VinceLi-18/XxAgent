# @deepseek-ai/node-addon-landlock-run-linux-x64

[English](README.md) | 中文

面向 linux-x64 的预构建 `bin/landlock-run` Landlock launcher：一个由内部 [`@deepseek-ai/node-addon-landlock-run`](../entry) workspace 中的 C 源码进行 native 编译而成的静态 musl binary（不使用交叉工具链）。Package 的 `os`/`cpu` 字段让 pnpm 在暂存应用时选择它；入口包将其解析为文件路径。该包不包含 JavaScript，也不会被 import。

该二进制文件被 git 忽略，并通过 `files` 列表进入 npm tarball；如果文件缺失或 ELF 架构错误，`prepack` 门禁会拒绝打包，发布流水线则会按字节核验打包的二进制文件与其来源 CI 构建产物一致。静态 musl 链接使同一个二进制文件同时适用于 glibc 和 musl 发行版，因此名称中没有 libc 后缀。

同级包：`@deepseek-ai/node-addon-landlock-run-linux-arm64`。
