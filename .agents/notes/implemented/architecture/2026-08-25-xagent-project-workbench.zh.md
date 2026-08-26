# Agent Note: XAgent 账号作用域项目工作台

Status: implemented

[English](2026-08-25-xagent-project-workbench.md) | 中文

## 问题

XAgent Business Profile 会由同一个 Host 进程服务多个账号。因此，项目工作台不能从浏览器 payload、Profile 本地状态或共享内存默认值推导身份、项目可见性、创建权限或当前工作上下文。账号切换和权限授权还必须让过期浏览器状态失效，同时不能给 Developer 或上游 Profile 增加 XAgent 行为。

## 决策

FastAPI 与 PostgreSQL 拥有账号能力、可见项目、已选择的工作台或项目上下文，以及 Session 作用域索引。Manager 按角色默认获得 `project.create`；Specialist 只有获得服务端授权后才拥有该能力。权限版本变化会撤销既有登录，浏览器必须重新认证后才能取得新的能力集合。

Host 授权器从已认证连接生成不可变 Principal，并在每个 `xagentProject` 或 `xagentArtifact` Remote 操作外建立由 Principal 包拥有的请求作用域。两个服务分别拥有独立的 `AsyncLocalStorage`，且都只从共享不可变作用域读取用户令牌。八个 Artifact 方法始终转发到 FastAPI，不缓存列表、详情或 URL。后端业务拒绝通过显式 `TypertRemoteFailure` 穿过 Typert；共享 RPC schema 识别稳定的 XAgent 错误码，未知异常仍映射为 `internal`。系统不信任任何类似身份的请求字段。

创建 Session 时使用账号在服务端选择的上下文：工作台上下文创建 private Session，项目上下文创建 project Session。项目引用登记及引用项目失权后的失败关闭继续以现有的[XAgent 认证与会话隔离决策](2026-08-25-xagent-auth-session-runtime.md)为权威。

浏览器连接公开一个惰性的请求头贡献服务。XAgent 账号插件是唯一贡献者：它读取 `xagent_csrf` Cookie，并为生成式 Remote 调用和既有 Web API Client 添加匹配请求头。没有该插件时，连接传输保持原有行为。

XAgent 项目客户端挂载生成式 Remote contribution，并发布一个账号作用域的工作台控制器。控制器把每次服务端 Bootstrap 作为项目状态的唯一来源，不把项目数据写入浏览器存储，并通过账号 epoch 与取消信号丢弃迟到响应。它使用可逆 Slot 注册项目浏览器、中央上下文标识、详情栏和操作遮罩。账号插件会在暴露另一个账号前重置工作台。宽屏把详情栏显示为第三栏，窄屏使用布局拥有的 drawer。Artifact Remote 调用只负责传输，不注册模型工具，也不增加模型可见输入。

只有 `xagent-business` 挂载项目 Host、账号 UI 与项目 UI 配置项。`xagent-developer`、普通 Web Profile 以及独立的 JiaxinAgent 仓库保留既有组合与行为。

## 考虑过的替代方案

**把项目列表和所选上下文持久化到 localStorage。** 不予采纳，因为浏览器存储不是授权来源，并可能在切换账号后短暂暴露前一账号的项目名称。

**在每个 Remote payload 中发送账号或角色字段。** 不予采纳，因为浏览器可以伪造这些字段；物理连接的已认证 Principal 才是 Host 唯一身份来源。

**在每个 XAgent Remote 调用方内分别处理 CSRF。** 不予采纳，因为 Session 与生成式 Remote 传输会发生分歧。惰性贡献服务让两种传输共享一个受生命周期约束的机制，同时不会改变未挂载贡献者的 Profile。

**把项目 UI 直接写入通用布局或侧栏。** 不予采纳，因为这会把上游 DSH Profile 与 XAgent 产品语义耦合。没有 XAgent registrant 时，Slot 会让通用壳保持不变。

## 后果

账号切换、项目可见性、项目创建与 Session 作用域均以服务端为权威。过期权限版本会强制重新认证，迟到响应不能恢复前一账号。稳定业务错误保持机器可读，同时不暴露 FastAPI 响应正文或凭据。

Business Profile 的首次认证工作台 Bootstrap 以及每次上下文切换现在都依赖 FastAPI。服务不可用时，项目界面会失败关闭，而不会显示缓存数据。通用连接与 Typert 载体增加了小型扩展点，但它们在 XAgent 之外保持惰性，并由普通 Profile 组合测试覆盖。

本记录保持活跃，因为可信身份来源、服务端上下文、禁止浏览器缓存、CSRF 贡献边界和纯 Slot UI 所有权，都是后续项目资料、协作收件箱与跨项目统计必须遵守的约束。
