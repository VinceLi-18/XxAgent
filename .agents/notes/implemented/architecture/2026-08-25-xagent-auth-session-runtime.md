# Agent Note: XAgent 认证与会话隔离运行时

Status: implemented

## Problem

Business Profile 面向多个真实用户时，本地 Profile 目录、浏览器提供的身份字段和进程内共享状态都不能构成认证或数据隔离边界。会话创建还跨越 Host 内存状态与远端数据库；任一侧先发布都会留下无法安全恢复的半成品。

## Decision

浏览器只持有 Host 写入的安全 Cookie。Host 向 FastAPI introspection 当前登录，生成绑定物理连接的不可变 Principal，并将 Principal 显式传入 RPC 与事件订阅。XAgent 授权服务采用封闭方法表，先验证连接、Principal 和用户令牌一致，再由 FastAPI 在当前用户事务与 PostgreSQL RLS 下决定 Session read 或 edit 权限。

FastAPI 是 Business 会话 Header 与仅追加事件的唯一持久化权威。远端不可用、身份失效或授权不明时全部失败关闭，不回退本地 JSONL。私有会话只允许 owner 访问，Manager 也不能读取其他用户私有会话；不可见与不存在使用同一 not-found 结果。

工作台 Session 保持 `private + project_id=null`，并以 `xagent_session_project_refs` 记录其模型结果引用的项目。内部登记接口只接受 owner 的私有 Session，在一个管理员事务内固定排序并锁定全部待登记项目，要求新旧引用都对当前 Principal 可见，再以账号、操作和幂等键去重；任一项目不可见时整批不写入且不返回项目 ID。应用角色只能读取自己私有 Session 的引用，fork 通过受限的 SECURITY DEFINER 函数在同一事务复制仍有权访问的引用，不能直接写引用表。

Session list 过滤含失权引用的工作台 Session；open、事件读取、append、fork、archive 和显式 authorize 在返回或使用幂等结果前校验全部引用的当前项目权限，任一失权统一返回 `session-not-found`。恢复全部项目权限后原 Session 与日志重新可见，失权期间不会写事件、创建 fork 或归档。项目 Session 不使用引用表，继续由自身 `project_id` 与项目 RLS 决定权限。

Host 在远端 Header 与 seed event 原子提交后才发布新 Agent。用户 RPC 的远端持久化调用运行在显式令牌作用域中；后台 append 只使用该 Session 已建立的内部租约。Host 启动期的 Workspace bootstrap 没有用户 Principal，因此 XAgent provider 对专用 `listForBootstrap()` 返回空数组，绝不以服务身份枚举用户会话。Business 保留 API Gateway 所需的内部 Workspace registry，但授权层拒绝全部 Workspace RPC。

`xagent-developer` 与上游 Profile 不装载这些服务，继续使用原本的本地持久化。委托令牌使用独立 Ed25519 密钥和短时、窄 audience claim，不替代浏览器登录或 Session 授权。

## Alternatives considered

**把用户身份放进 RPC payload 或自定义请求头。** 浏览器可以伪造这些值，无法建立可信 Principal。

**用服务身份直接读取全部会话，再在 Host 过滤。** 这会扩大泄漏面，并绕过数据库的用户事务与 RLS。

**远端失败时回退本地 JSONL。** 同一 Session 会产生两个权威来源，既破坏隔离，也无法保证写入顺序和撤权即时生效。

**启动时用任意用户令牌填充 Workspace registry。** 启动结果会依赖某个用户并把其会话带入共享进程状态。

**登记时保存一次权限快照。** 账号权限会在 Session 存续期间变化；只验证登记时状态会让旧工作台日志在项目失权后继续暴露。每次 Session 授权重新比较引用与当前可见项目，日志本身无需复制或删除。

**只在工作台列表隐藏失权 Session。** 已知 Session ID、事件、写入、分叉和幂等重放仍能绕过列表。统一授权钩子在所有读取和变更入口执行同一引用检查。

## Consequences

Business 的登录可以服务端撤销，账号停用、密码重置和权限版本变化都会使旧登录失效。每个会话读写都由 Principal、FastAPI 授权事务和 PostgreSQL RLS 共同约束；双账号不能列出、读取或猜中对方私有会话。远端写入失败时不会发布新 Agent 或继续模型调用。

跨项目统计可以保留一份工作台日志，而不把项目内容复制为独立 Session。该能力以每次访问都查询当前项目权限和 fork 同步继承引用为代价；引用数量与 Session 列表大小会增加授权查询成本，且任何一个引用失权都会暂时隐藏整份工作台 Session。

该记录保留在活跃架构决策中，因为 Principal 来源、失败关闭、远端单一权威、启动期空枚举和 Profile 隔离范围是后续项目、Artifact、审批与多用户部署必须继续遵守的安全边界。
