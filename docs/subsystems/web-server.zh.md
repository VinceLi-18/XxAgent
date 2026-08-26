# HTTP 服务器

[English](web-server.md) | 中文

[dsh-host-webserver](../../packages/host/webserver) 是 GUI 宿主的浏览器 HTTP 载体：它是一个提供 `ctx.webServer` 的 `node:http` 插件，包含具名路由注册表、index.html 转换回调，以及一个可由插件认领的回退处理器。它不属于 agent loop（智能体循环），也不是能力 seam；它不了解任何 harness 概念。其他插件负责注册所有功能路由，包括 `/api` 桥接、插件 bundle 和 HMR（热模块替换）事件流（[分层说明](../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)）。该服务器只服务浏览器：Electron 通过 `file://` 加载已构建文件，并经 IPC 桥接发送 fetch 请求，不使用本服务器。

源码：[`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

## 路由

```ts type-equiv
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
type WebRouteKind = 'exact' | 'prefix'
```

```ts type-equiv
/** One named route registration. */
interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
```

匹配顺序固定：先查 exact 表，再取最长匹配前缀，最后落到已注册的回退。注册顺序不携带任何面向请求的语义：具名路由在组合上互不相交，任何未被具名路由认领的请求都由回退席位应答；席位只有一个所有者，第二次注册会抛出异常。发布的 Web 组合用 [`dsh-host-frontend-static`](../../packages/host/frontend-static/src/index.ts) 认领席位，即遵循固定语义的 SPA dist 服务器：非 GET/HEAD 返回 405，越出 dist 根目录的遍历返回 403，任何未命中都以 HTTP 200 回退到 `index.html`（SPA 路由），未知扩展名按 octet-stream 发送。

## 配置

```ts type-equiv
/** Gateway config: the listen address. */
interface Config {
  /** Listen host; the two supported values are loopback and all-interfaces. */
  host: '127.0.0.1' | '0.0.0.0'
  /** Listen port; zero requests an OS-assigned port. */
  port: number
}
```

`host` 只接受 `127.0.0.1`（默认姿态）和 `0.0.0.0`（刻意的网络暴露）；没有 TLS、认证或 origin 策略，因此绑定到非回环地址会把服务器暴露给该网络。dist 位置是认领席位的前端插件的组装事实。

## 服务

`WebServer`（`ctx.webServer`）在激活时立即监听；监听失败（EADDRINUSE 等）会使初始化被拒绝，启动进程会报告失败的 fiber。`register(route)` 添加一条具名路由并返回其 disposer；重复的 `(kind, path)` 抛出异常，因为路由模式是组合层约定，冲突即配置错误。`tapIndex(transform)` 添加一个纯 HTML 到 HTML 转换函数，按注册顺序应用于每个 index 响应（`/` 和每次 SPA 回退）；[dsh-client-modules](../../packages/client/modules) 用它注入启动 manifest（元数据清单）。`port` 读取监听端口，包括 `config.port` 为 0 时操作系统分配的端口。

处理过程中抛出异常的请求（畸形的 % 转义撞上 `decodeURIComponent`、客户端在请求体中途断开）会记录为警告并应答 400（响应头已发出时则销毁 socket），绝不导致进程退出。dispose（资源释放）把 `close()` 与 `closeAllConnections()` 配对使用，因为处理器可能像 SSE（Server-Sent Events）那样保持响应打开，而这类连接永远不会自行结束；没有强制关闭，拆卸就会挂起。该包从不打印输出：URL 行归 shell 所有。逐包运维细节（含开发模式的 bundle 监视流水线）留在 [README](../../packages/host/webserver/README.md) 中。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconnectionrequestcontextresolver--xagentconnectionauthservice"></a>

### `ctx.connectionRequestContextResolver` — `XAgentConnectionAuthService`

Connection 可选解析服务；通用传输只依赖其结构，不导入 XAgent。

```ts cordis-catalog
/**
 * Resolve one HTTP request into a context bound to its physical connection.
 * @param request - browser request carrying only Host-managed credentials.
 * @param connectionId - Host-generated physical connection identifier.
 * @param signal - request cancellation signal.
 * @returns the authenticated context used by RPC authorization.
 */
resolve(request: Request, connectionId: string, signal: AbortSignal): Promise<ResolvedConnectionRequestContext>
```

Source: [`packages/xagent/connection-auth/src/index.ts:48`](../../packages/xagent/connection-auth/src/index.ts)

<a id="ctxwebserver--webserver"></a>

### `ctx.webServer` — `WebServer`

The browser HTTP carrier service. Activation listens immediately. Route registration order does not affect requests because configured named routes must be distinct, and the fallback handler answers anything not yet claimed during startup with 404 until its owner registers. A listen failure rejects initialization, and the boot process reports the failed fiber.

```ts cordis-catalog
/**
 * Register a named route. Duplicate (kind, path) throws — route patterns are
 * a composition-level contract, so a collision is a misconfiguration.
 * @param route - kind, path, and the owning handler.
 * @returns the disposer removing the route.
 */
register(route: WebRoute): () => void

/**
 * Register an exact-path HTTP upgrade route. Duplicate paths throw because
 * one socket can have only one protocol owner.
 * @param route - pathname and handler owning negotiation plus socket use.
 * @returns the disposer removing the route.
 */
registerUpgrade(route: WebUpgradeRoute): () => void

/**
 * Claim the fallback seat: the handler answering every request no named
 * route matches (the SPA dist server in the shipped Web composition). One
 * owner only — a second registration throws, because two fallbacks cannot
 * compose.
 * @param handler - owns the full response lifecycle of unmatched requests.
 * @returns the disposer releasing the seat.
 */
registerFallback(handler: WebRoute['handler']): () => void

/**
 * Register an index.html transform, applied by the fallback owner to every
 * index response ({@link applyIndexTaps}) in registration order.
 * @param transform - pure html-to-html function.
 * @returns the disposer removing the transform.
 */
tapIndex(transform: (html: string) => string): () => void

/**
 * Run an index.html body through the registered taps in registration order
 * — called by the fallback owner on every index response it renders.
 * @param html - the raw index.html body.
 * @returns the transformed body.
 */
applyIndexTaps(html: string): string
```

Source: [`packages/host/webserver/src/index.ts:59`](../../packages/host/webserver/src/index.ts)

<a id="ctxxagentartifact--xagentartifactservice"></a>

### `ctx.xagentArtifact` — `XAgentArtifactService`

将账号绑定请求逐次转发给 FastAPI 的资料服务。

```ts cordis-catalog
/**
 * 在 Host 认证所得的单请求身份内执行完整 Remote 调用。
 * @param scope - 物理连接绑定的可信 Principal 与用户令牌。
 * @param operation - 下游完整 Remote 操作。
 * @returns 下游结果；退出时自动清除请求身份。
 */
async withRequest<T>(scope: XAgentAuthenticatedRequestScope, operation: () => Promise<T>): Promise<T>

/**
 * 列出当前 FastAPI 工作台范围内可见的资料。
 * @param signal - 物理请求的取消信号。
 * @returns 当前请求重新读取的资料摘要。
 */
@Remote async list(signal?: AbortSignal): Promise<readonly XAgentArtifactSummary[]>

/**
 * 读取当前账号可见的一份资料与版本历史。
 * @param artifactId - 资料 UUID。
 * @param signal - 物理请求的取消信号。
 * @returns FastAPI 当前资料详情。
 */
@Remote async detail(artifactId: string, signal?: AbortSignal): Promise<XAgentArtifactDetail>

/**
 * 创建当前 FastAPI 工作台范围内的新资料暂存上传。
 * @param input - 文件名、声明大小和幂等键。
 * @param signal - 物理请求的取消信号。
 * @returns 单个暂存对象的短期 PUT 授权。
 */
@Remote('create-upload') async createUpload(input: XAgentArtifactUploadInput, signal?: AbortSignal): Promise<XAgentArtifactUpload>

/**
 * 为一份现有资料创建不可变新版本的暂存上传。
 * @param artifactId - 资料 UUID。
 * @param input - 文件名、声明大小和幂等键。
 * @param signal - 物理请求的取消信号。
 * @returns 单个暂存对象的短期 PUT 授权。
 */
@Remote('create-version-upload') async createVersionUpload( artifactId: string, input: XAgentArtifactUploadInput, signal?: AbortSignal, ): Promise<XAgentArtifactUpload>

/**
 * 完成暂存上传并把新版本提交到异步安全处理队列。
 * @param uploadId - 暂存上传 UUID。
 * @param input - 实际大小、SHA-256 和幂等键。
 * @param signal - 物理请求的取消信号。
 * @returns 新版本进入处理队列后的资料详情。
 */
@Remote('complete-upload') async completeUpload( uploadId: string, input: XAgentArtifactCompleteInput, signal?: AbortSignal, ): Promise<XAgentArtifactDetail>

/**
 * 重试一份仍有有效暂存正文的失败版本。
 * @param versionId - 资料版本 UUID。
 * @param idempotencyKey - 当前重试意图的幂等键。
 * @param signal - 物理请求的取消信号。
 * @returns 重试入队后的资料详情。
 */
@Remote async retry(versionId: string, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentArtifactDetail>

/**
 * 为 clean 版本创建一次新的安全预览地址。
 * @param versionId - 资料版本 UUID。
 * @param signal - 物理请求的取消信号。
 * @returns FastAPI 授权的短期 opaque 地址。
 */
@Remote async preview(versionId: string, signal?: AbortSignal): Promise<{ readonly url: string }>

/**
 * 为 clean 版本创建一次新的安全下载地址。
 * @param versionId - 资料版本 UUID。
 * @param signal - 物理请求的取消信号。
 * @returns FastAPI 授权的短期 opaque 地址。
 */
@Remote async download(versionId: string, signal?: AbortSignal): Promise<{ readonly url: string }>
```

Source: [`packages/xagent/artifact/src/index.ts:75`](../../packages/xagent/artifact/src/index.ts)

<a id="ctxxagentprincipal--xagentprincipalservice-abstract-seam"></a>

### `ctx.xagentPrincipal` — `XAgentPrincipalService` (abstract seam)

XAgent Host 的 Principal 解析服务；实现必须通过 FastAPI introspection。

```ts cordis-catalog
/**
 * Introspect a login token and bind the resulting actor to one Host connection.
 * @param userToken - opaque FastAPI login token.
 * @param connectionId - Host-generated physical connection identifier.
 * @param signal - optional introspection cancellation signal.
 * @returns an immutable validated Principal.
 */
abstract resolve(userToken: string, connectionId: string, signal?: AbortSignal): Promise<XAgentPrincipal>
```

Source: [`packages/xagent/principal/src/index.ts:60`](../../packages/xagent/principal/src/index.ts)

<a id="ctxxagentproject--xagentprojectservice"></a>

### `ctx.xagentProject` — `XAgentProjectService`

将账号绑定请求转发给 FastAPI 的项目工作台服务。

```ts cordis-catalog
/**
 * 在 Host 认证所得的单请求身份内执行完整 Remote 调用。
 * @param scope - 物理连接绑定的可信 Principal 与用户令牌。
 * @param operation - 下游完整 Remote 操作。
 * @returns 下游结果；退出时自动清除请求身份。
 */
async withRequest<T>(scope: XAgentAuthenticatedRequestScope, operation: () => Promise<T>): Promise<T>

/**
 * 读取当前账号的完整工作台状态。
 * @param signal - 物理请求的取消信号。
 * @returns FastAPI 当前可见的账号、能力、上下文、项目和会话摘要。
 */
@Remote('bootstrap') async bootstrap(signal?: AbortSignal): Promise<XAgentWorkbenchBootstrap>

/**
 * 为当前账号选择跨项目工作台或单项目上下文。
 * @param context - 目标工作台或项目上下文。
 * @param signal - 物理请求的取消信号。
 * @returns FastAPI 提交选择后重新读取的完整工作台状态。
 */
@Remote('select-context') async selectContext(context: XAgentWorkbenchContext, signal?: AbortSignal): Promise<XAgentWorkbenchBootstrap>

/**
 * 使用服务端能力检查为当前账号创建项目。
 * @param name - 用户提交的项目名称。
 * @param idempotencyKey - 当前创建意图的幂等键。
 * @param signal - 物理请求的取消信号。
 * @returns FastAPI 创建项目后重新读取的完整工作台状态。
 */
@Remote('create-project') async createProject(name: string, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentWorkbenchBootstrap>

/**
 * 读取当前账号可见的一个项目详情。
 * @param projectId - 当前账号请求查看的项目 UUID。
 * @param signal - 物理请求的取消信号。
 * @returns 与请求 Principal 账号一致的项目详情。
 */
@Remote('project') async project(projectId: string, signal?: AbortSignal): Promise<XAgentProjectDetail>
```

Source: [`packages/xagent/project/src/index.ts:67`](../../packages/xagent/project/src/index.ts)
<!-- END GENERATED cordis-surface -->
