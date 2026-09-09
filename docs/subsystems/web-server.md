# HTTP Server

English | [中文](web-server.zh.md)

[dsh-host-webserver](../../packages/host/webserver) is the browser HTTP carrier for the GUI host: a single `node:http` plugin providing `ctx.webServer`, a named-route registry, index.html transform callbacks, and one fallback handler that a plugin may claim. It is not part of the agent loop and not a capability seam; it knows no harness concepts, and another plugin registers every feature route, including the `/api` bridge, plugin bundles, and the HMR event stream ([layering note](../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)). It serves browsers only: Electron loads the built files over `file://` and sends fetch requests through an IPC bridge instead of this server.

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

## Routes

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

Match order is fixed: exact table first, then longest matching prefix, then the registered fallback. Registration order carries no request-facing semantics — named routes are composed to be disjoint, and the fallback seat answers anything no named route claims; one owner only, a second registration throws. The shipped Web composition claims the seat with [`dsh-host-frontend-static`](../../packages/host/frontend-static/src/index.ts), the SPA dist server with locked semantics: non-GET/HEAD is 405, traversal outside the dist root is 403, any miss falls back to `index.html` with HTTP 200 (SPA routing), and unknown extensions ship as octet-stream.

## Config

```ts type-equiv
/** Gateway config: the listen address. */
interface Config {
  /** Listen host; the two supported values are loopback and all-interfaces. */
  host: '127.0.0.1' | '0.0.0.0'
  /** Listen port; zero requests an OS-assigned port. */
  port: number
}
```

`host` accepts only `127.0.0.1` (default posture) and `0.0.0.0` (deliberate network exposure); there is no TLS, auth, or origin policy, so a non-loopback bind exposes the server to that network. The dist location is an assembly fact of the frontend plugin that claims the seat.

## The service

`WebServer` (`ctx.webServer`) listens immediately on activation; a listen failure (EADDRINUSE…) rejects initialization, and the boot process reports the failed fiber. `register(route)` adds one named route and returns its disposer; a duplicate `(kind, path)` throws because route patterns are a composition-level contract and a collision is a misconfiguration. `tapIndex(transform)` adds a pure html-to-html transform applied to every index response — `/` and each SPA fallback — in registration order; [dsh-client-modules](../../packages/client/modules) uses it to inject the boot manifest. `port` reads the listening port, including the port assigned by the OS when `config.port` is 0.

A request whose handling throws (a malformed %-escape hitting `decodeURIComponent`, a client dropping mid-body) is logged as a warning and answered 400 — or the socket destroyed when headers are already out — never a process exit. Disposal pairs `close()` with `closeAllConnections()` because a handler may hold its response open (SSE) and such connections never end on their own; without the force-close, teardown would hang. The package never prints: the URL line belongs to the shell. Per-package operational detail, including the dev-mode bundle watch pipeline, stays in the [README](../../packages/host/webserver/README.md).

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

Source: [`packages/xagent/artifact/src/index.ts:196`](../../packages/xagent/artifact/src/index.ts)

<a id="ctxxagentcitation--xagentcitationremoteservice"></a>

### `ctx.xagentCitation` — `XAgentCitationRemoteService`

Request-scoped citation locator backed by durable provenance and current-actor authorization.

```ts cordis-catalog
/**
 * Run one Remote operation inside the Host-authenticated Session scope.
 * @param scope - current physical connection, actor, revision, and Session identity.
 * @param operation - complete downstream Remote operation.
 * @returns the downstream result after request-local identity is cleared.
 */
async withRequest<T>(scope: XAgentAuthenticatedSessionRequestScope, operation: () => Promise<T>): Promise<T>

/**
 * Resolve one durable cited-answer ID through server-owned provenance and
 * current-actor authorization.
 * @param sessionId - current Browser Session id.
 * @param citationId - persisted short citation id.
 * @param signal - Browser request cancellation.
 * @returns immutable Artifact, Version, Chunk, and line identities without a URL.
 */
@Remote async resolve(sessionId: string, citationId: string, signal?: AbortSignal): Promise<XAgentCitationTarget>

/**
 * Close admission, abort every resolution, and await their settlement.
 * @returns when all owned backend operations have settled.
 */
async dispose(): Promise<void>
```

Source: [`packages/xagent/retrieval/src/index.ts:270`](../../packages/xagent/retrieval/src/index.ts)

<a id="ctxxagentfact--xagentfactservice"></a>

### `ctx.xagentFact` — `XAgentFactService`

Request-scoped FastAPI Fact provider.

```ts cordis-catalog
/**
 * Prepare one proposal and register its private receipt before returning the public result.
 * @param input - business fields, evidence identities, and the authoritative tool-call identity.
 * @returns the public pending proposal identity without its private receipt.
 */
async proposeFact(input: XAgentProposeFactInput): Promise<{ readonly proposalId: string; readonly status: 'pending' }>

/**
 * Run one Remote operation under an authenticated Project Session scope.
 * @param scope - immutable identity derived from the physical authenticated connection.
 * @param operation - one complete Remote operation to bind to that identity.
 * @returns the operation result while the scope remains active.
 */
async withRequest<T>(scope: XAgentAuthenticatedSessionRequestScope, operation: () => Promise<T>): Promise<T>

/**
 * List current Fact heads.
 * @param sessionId - caller-selected Session, which must equal the physical request Session.
 * @param input - bounded page selection.
 * @param signal - optional caller cancellation.
 * @returns one page of current Fact revisions in the fixed project.
 */
@Remote('list-heads') listHeads(sessionId: string, input: XAgentFactPageInput, signal?: AbortSignal): Promise<XAgentFactPage<XAgentFactRevision>>

/**
 * List public proposals.
 * @param sessionId - caller-selected Session, which must equal the physical request Session.
 * @param input - bounded page selection.
 * @param signal - optional caller cancellation.
 * @returns one page of public proposals in the fixed project.
 */
@Remote('list-proposals') listProposals(sessionId: string, input: XAgentFactPageInput, signal?: AbortSignal): Promise<XAgentFactPage<XAgentFactProposal>>

/**
 * Read one revision.
 * @param sessionId - caller-selected Session, which must equal the physical request Session.
 * @param revisionId - immutable revision identity.
 * @param signal - optional caller cancellation.
 * @returns the revision and its history under current authorization.
 */
@Remote revision(sessionId: string, revisionId: string, signal?: AbortSignal): Promise<XAgentFactRevisionDetail>

/**
 * Read one proposal.
 * @param sessionId - caller-selected Session, which must equal the physical request Session.
 * @param proposalId - proposal identity to reauthorize.
 * @param signal - optional caller cancellation.
 * @returns the current public proposal state.
 */
@Remote proposal(sessionId: string, proposalId: string, signal?: AbortSignal): Promise<XAgentFactProposal>

/**
 * Approve one proposal.
 * @param sessionId - caller-selected Session, which must equal the physical request Session.
 * @param proposalId - pending proposal identity.
 * @param input - decision note and fresh operation idempotency key.
 * @param signal - optional caller cancellation.
 * @returns the durable terminal decision.
 */
@Remote approve( sessionId: string, proposalId: string, input: XAgentFactApproveInput, signal?: AbortSignal, ): Promise<XAgentFactProposalDecision>

/**
 * Reject one proposal.
 * @param sessionId - caller-selected Session, which must equal the physical request Session.
 * @param proposalId - pending proposal identity.
 * @param input - rejection reason and fresh operation idempotency key.
 * @param signal - optional caller cancellation.
 * @returns the durable terminal decision.
 */
@Remote reject( sessionId: string, proposalId: string, input: XAgentFactRejectInput, signal?: AbortSignal, ): Promise<XAgentFactProposalDecision>

/**
 * Withdraw one proposal.
 * @param sessionId - caller-selected Session, which must equal the physical request Session.
 * @param proposalId - pending proposal identity.
 * @param input - fresh operation idempotency key.
 * @param signal - optional caller cancellation.
 * @returns the durable terminal decision.
 */
@Remote withdraw( sessionId: string, proposalId: string, input: XAgentFactWithdrawInput, signal?: AbortSignal, ): Promise<XAgentFactProposalDecision>

/** Close new work synchronously, abort owned calls, and await their settlement. */
async dispose(): Promise<void>

/**
 * Return the first violated live owner relationship without inspecting fixed examples.
 * @returns a stable diagnostic when active scope or Outbox ownership is inconsistent.
 */
relationshipIssue(): string | undefined
```

Source: [`packages/xagent/fact/src/index.ts:314`](../../packages/xagent/fact/src/index.ts)

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

Source: [`packages/xagent/principal/src/index.ts:115`](../../packages/xagent/principal/src/index.ts)

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

Source: [`packages/xagent/project/src/index.ts:59`](../../packages/xagent/project/src/index.ts)

<a id="ctxxagentretrieval--xagentretrieval-abstract-seam"></a>

### `ctx.xagentRetrieval` — `XAgentRetrieval` (abstract seam)

Service Definition consumed by model tools and the terminal cited-answer runtime.

```ts cordis-catalog
/**
 * Discover accessible projects for the exact authenticated Private Session.
 * @param input - immutable Session/tool identity and optional bounded name query.
 * @returns at most twenty accessible projects and the public payload hash.
 */
abstract listAccessibleProjects(input: XAgentListAccessibleProjectsInput): Promise<XAgentAccessibleProjects>

/**
 * Search Artifact evidence within the exact authenticated Session scope.
 * @param input - immutable identity, query, and explicit Private Session selectors.
 * @returns authorized citation excerpts and the public payload hash.
 */
abstract searchArtifacts(input: XAgentSearchArtifactsInput): Promise<XAgentArtifactSearch>
```

Source: [`packages/xagent/retrieval/src/index.ts:158`](../../packages/xagent/retrieval/src/index.ts)
<!-- END GENERATED cordis-surface -->
