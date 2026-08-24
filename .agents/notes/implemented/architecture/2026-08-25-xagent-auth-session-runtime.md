# Agent Note: XAgent 认证与会话隔离运行时

Status: implemented

## Problem

Business Profile 面向多个真实用户时，本地 Profile 目录、浏览器提供的身份字段和进程内共享状态都不能构成认证或数据隔离边界。会话创建还跨越 Host 内存状态与远端数据库；任一侧先发布都会留下无法安全恢复的半成品。

## Decision

浏览器只持有 Host 写入的安全 Cookie。Host 向 FastAPI introspection 当前登录，生成绑定物理连接的不可变 Principal，并将 Principal 显式传入 RPC 与事件订阅。XAgent 授权服务采用封闭方法表，先验证连接、Principal 和用户令牌一致，再由 FastAPI 在当前用户事务与 PostgreSQL RLS 下决定 Session read 或 edit 权限。

FastAPI 是 Business 会话 Header 与仅追加事件的唯一持久化权威。远端不可用、身份失效或授权不明时全部失败关闭，不回退本地 JSONL。私有会话只允许 owner 访问，Manager 也不能读取其他用户私有会话；不可见与不存在使用同一 not-found 结果。

Host 在远端 Header 与 seed event 原子提交后才发布新 Agent。用户 RPC 的远端持久化调用运行在显式令牌作用域中；后台 append 只使用该 Session 已建立的内部租约。Host 启动期的 Workspace bootstrap 没有用户 Principal，因此 XAgent provider 对专用 `listForBootstrap()` 返回空数组，绝不以服务身份枚举用户会话。Business 保留 API Gateway 所需的内部 Workspace registry，但授权层拒绝全部 Workspace RPC。

`xagent-developer` 与上游 Profile 不装载这些服务，继续使用原本的本地持久化。委托令牌使用独立 Ed25519 密钥和短时、窄 audience claim，不替代浏览器登录或 Session 授权。

## Alternatives considered

**把用户身份放进 RPC payload 或自定义请求头。** 浏览器可以伪造这些值，无法建立可信 Principal。

**用服务身份直接读取全部会话，再在 Host 过滤。** 这会扩大泄漏面，并绕过数据库的用户事务与 RLS。

**远端失败时回退本地 JSONL。** 同一 Session 会产生两个权威来源，既破坏隔离，也无法保证写入顺序和撤权即时生效。

**启动时用任意用户令牌填充 Workspace registry。** 启动结果会依赖某个用户并把其会话带入共享进程状态。

## Consequences

Business 的登录可以服务端撤销，账号停用、密码重置和权限版本变化都会使旧登录失效。每个会话读写都由 Principal、FastAPI 授权事务和 PostgreSQL RLS 共同约束；双账号不能列出、读取或猜中对方私有会话。远端写入失败时不会发布新 Agent 或继续模型调用。

该记录保留在活跃架构决策中，因为 Principal 来源、失败关闭、远端单一权威、启动期空枚举和 Profile 隔离范围是后续项目、Artifact、审批与多用户部署必须继续遵守的安全边界。
