# Agent Note: XAgent 账号作用域项目工作台

Status: implemented

[English](2026-08-25-xagent-project-workbench.md) | 中文

## 问题

XAgent Business Profile 会由同一个 Host 进程服务多个账号。因此，项目工作台不能从浏览器 payload、Profile 本地状态或共享内存默认值推导身份、项目可见性、创建权限或当前工作上下文。账号切换和权限授权还必须让过期浏览器状态失效，同时不能给 Developer 或上游 Profile 增加 XAgent 行为。

## 决策

FastAPI 与 PostgreSQL 拥有账号能力、可见项目、已选择的工作台或项目上下文，以及经过授权的 Session 记录。Manager 按角色默认获得 `project.create`；Specialist 只有获得服务端授权后才拥有该能力。权限版本变化会撤销既有登录，浏览器必须重新认证后才能取得新的能力集合。

Host 后端客户端从一次经过认证的 Bootstrap 响应生成工作台 Session 范围与计数。FastAPI 通过共享 Session 可见性与私有项目引用检查后返回最小普通对话记录；Host 不接收未经授权的记录进行过滤。没有运行时 Header 的普通对话计数但没有可打开范围，隐藏的 Business Skill 测试 Session 则不进入响应。Bootstrap 使用内部 schema 版本 2 并拒绝版本不匹配；其他工作台操作保持版本 1。Host 与 API 配套部署或回滚，无需数据库转换。[Phase 7A 设计](../../../../docs/superpowers/specs/2026-09-13-xagent-phase-7a-workbench-design.md)定义本批迁移。

Host 授权器从已认证连接生成不可变 Principal，并在每个 `xagentProject` 或 `xagentArtifact` Remote 操作外建立由 Principal 包拥有的请求作用域。两个服务分别拥有独立的 `AsyncLocalStorage`，且都只从共享不可变作用域读取用户令牌。八个 Artifact 方法始终转发到 FastAPI，不缓存列表、详情或 URL。后端业务拒绝通过显式 `TypertRemoteFailure` 穿过 Typert；共享 RPC schema 识别稳定的 XAgent 错误码，未知异常仍映射为 `internal`。系统不信任任何类似身份的请求字段。

Artifact 正文使用固定的 Host 同源路由，上游只能来自配置的 FastAPI origin。路由只把 signed-bearer query 转发给 FastAPI，拒绝重定向和调用方选择的目标，并为每个响应固定设置 `Cache-Control: private, no-store`。路由 owner 跟踪 active fetch 与正文流；插件释放先注销路由，再取消并等待所有已跟踪工作。路由专用 ASGI middleware 从 Uvicorn 拥有的 access-log scope 移除 query，同时把包含精确 query 的 scope 副本交给 FastAPI 验证。Host 日志、API access log 和 Browser 失败诊断均不保留 signed query。

创建 Session 时使用账号在服务端选择的上下文：工作台上下文创建 private Session，项目上下文创建 project Session。项目引用登记及引用项目失权后的失败关闭继续以现有的[XAgent 认证与会话隔离决策](2026-08-25-xagent-auth-session-runtime.md)为权威。

浏览器连接公开一个惰性的请求头贡献服务。XAgent 账号插件是唯一贡献者：它读取 `xagent_csrf` Cookie，并为生成式 Remote 调用和既有 Web API Client 添加匹配请求头。没有该插件时，连接传输保持原有行为。

XAgent 项目客户端挂载生成式 Remote contribution，并发布一个账号作用域的工作台控制器。控制器把每次服务端 Bootstrap 作为项目状态的唯一来源，不把项目数据写入浏览器存储，并通过账号 epoch 与取消信号丢弃迟到响应。它使用可逆 Slot 注册项目浏览器、中央上下文标识、详情栏和操作遮罩。账号插件会在暴露另一个账号前重置工作台。宽屏把详情栏显示为第三栏，窄屏使用布局拥有的 drawer。Artifact Remote 调用只负责传输，不注册模型工具，也不增加模型可见输入。

只有 `xagent-business` 挂载项目 Host、账号 UI 与项目 UI 配置项。`xagent-developer`、普通 Web Profile 以及独立的 JiaxinAgent 仓库保留既有组合与行为。

## 考虑过的替代方案

**在 Host 分别获取项目与 Session。** 未采用，因为工作台组装会跨越独立授权事务并增加 HTTP 请求。一次后端响应保留现有事务与请求生命周期，由 TypeScript 负责派生计数。

**把项目列表和所选上下文持久化到 localStorage。** 不予采纳，因为浏览器存储不是授权来源，并可能在切换账号后短暂暴露前一账号的项目名称。

**在每个 Remote payload 中发送账号或角色字段。** 不予采纳，因为浏览器可以伪造这些字段；物理连接的已认证 Principal 才是 Host 唯一身份来源。

**在每个 XAgent Remote 调用方内分别处理 CSRF。** 不予采纳，因为 Session 与生成式 Remote 传输会发生分歧。惰性贡献服务让两种传输共享一个受生命周期约束的机制，同时不会改变未挂载贡献者的 Profile。

**把项目 UI 直接写入通用布局或侧栏。** 不予采纳，因为这会把上游 DSH Profile 与 XAgent 产品语义耦合。没有 XAgent registrant 时，Slot 会让通用壳保持不变。

**把 signed 正文 URL 直接交给 FastAPI 或对象存储。** 不予采纳，因为 Browser 会得知后端 origin 或存储地址，并跨过 Host 同源策略。固定 Host 路由让服务端拥有目标选择权，同时不削弱 FastAPI 验签。

**关闭 API 的 Uvicorn access log。** 不予采纳，因为其他路由、状态和客户端诊断仍有价值。只修改正文路由的日志 scope，可以移除 bearer 并保留普通访问日志。

**取消 active 正文请求但不等待结算。** 不予采纳，因为路由移除会在旧 fetch 或流仍可能写入响应时报告释放完成。active registry 让静止状态可观察且有序。

## 后果

客户端测试固定计数与范围投影、畸形记录拒绝及保持不变的公开结果。PostgreSQL API 测试覆盖空运行时 Header、隐藏测试 Session、当前账号隔离及私有引用撤权。项目详情计数继续使用 SQL 聚合，不为计数而传输数据库记录。

账号切换、项目可见性、项目创建与 Session 作用域均以服务端为权威。过期权限版本会强制重新认证，迟到响应不能恢复前一账号。稳定业务错误保持机器可读，同时不暴露 FastAPI 响应正文或凭据。

Business Profile 的首次认证工作台 Bootstrap 以及每次上下文切换现在都依赖 FastAPI。服务不可用时，项目界面会失败关闭，而不会显示缓存数据。通用连接与 Typert 载体增加了小型扩展点，但它们在 XAgent 之外保持惰性，并由普通 Profile 组合测试覆盖。

正文响应不能被 Browser 或中间缓存复用，signed query 也不会进入常规诊断。该选择需要一个固定 Host 代理和一个路由专用 API 日志 middleware；插件释放会在取消后等待每个已跟踪 fetch 与正文流结算，因此忽略取消的上游工作会让释放保持等待。

本记录保持活跃，因为可信身份来源、服务端上下文、禁止浏览器缓存、CSRF 贡献边界和纯 Slot UI 所有权，都是后续项目资料、协作收件箱与跨项目统计必须遵守的约束。
