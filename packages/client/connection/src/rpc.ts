/** Generic unary RPC contracts shared by the Host and Client Connection halves. */

import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'

/** Trust fence applied before a Host RPC channel reaches its handler. */
export type ConnectionRpcAuthority = 'trusted-host' | 'loopback'

/** Registration policy for one logical RPC channel. */
export interface ConnectionRpcHandlerOptions {
  /** Browser authority accepted by every endpoint in this channel. */
  readonly authority: ConnectionRpcAuthority
}

/** Host 为一个物理 HTTP 请求或 WebSocket 连接生成的显式上下文。 */
export interface ConnectionRequestContext {
  readonly principal?: unknown
  readonly userToken?: string
  readonly connectionId: string
  /** Host-decoded RPC correlation id; absent on event-stream connections. */
  readonly requestId?: string
  /** Authenticated physical connection lifetime, when supplied by the resolver. */
  readonly lifetime?: AbortSignal
}

/** 可选认证服务返回的字段；Host 独占 connectionId。 */
export interface ResolvedConnectionRequestContext {
  readonly principal?: unknown
  readonly userToken?: string
  /** 认证失效时终止该物理长连接；普通 HTTP 请求无需提供。 */
  readonly lifetime?: AbortSignal
}

/** 可选的部署认证扩展点；通用 Connection 不依赖具体产品身份包。 */
export interface ConnectionRequestContextResolver {
  resolve(
    request: Request,
    connectionId: string,
    signal: AbortSignal,
  ): Promise<ResolvedConnectionRequestContext>
}

/** 可选的部署授权扩展点；实现包围一次已认证 RPC，且不得信任 payload 中的身份字段。 */
export interface ConnectionRequestAuthorizer {
  run<T>(
    endpoint: string,
    payload: unknown,
    request: ConnectionRequestContext,
    signal: AbortSignal,
    operation: () => Promise<RpcResult<T>>,
  ): Promise<RpcResult<T>>

  /**
   * Filter or project one server-push frame for the authenticated physical
   * connection. Returning undefined suppresses the frame.
   */
  filterEvent?(
    endpoint: 'events.mux' | 'events.host',
    frame: unknown,
    request: ConnectionRequestContext,
    signal: AbortSignal,
  ): Promise<unknown>
}

/** Handler invoked after Connection has decoded the transport envelope. */
export type ConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  request: ConnectionRequestContext,
) => Promise<RpcResult<unknown>>

/** Synchronous ownership test for one endpoint on a shared RPC channel. */
export type ConnectionRpcEndpointMatcher = (endpoint: string) => boolean

/** Host registry for logical RPC channels carried by the current transport. */
export interface HostConnectionRpc {
  /**
   * Register one absolute channel prefix and its trust policy.
   * @param channel - absolute logical channel such as `/rpc`.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @param options - channel trust policy.
   * @returns asynchronous disposer removing the channel and its physical route.
   */
  handle(
    channel: string,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void>

  /**
   * Intercept owned endpoints on the shared `/api` channel before its fallback.
   * @param channel - reserved shared channel; currently `/api`.
   * @param matches - synchronous endpoint ownership test.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @param options - trust policy for every endpoint claimed by this interceptor.
   * @returns asynchronous disposer removing the interceptor.
   */
  intercept(
    channel: '/api',
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void>
}

/** Host `ctx.connection` shape consumed by transport-independent adapters. */
export interface HostConnectionHandle {
  /** Generic RPC channel registry. */
  readonly rpc: HostConnectionRpc
}

/** Client caller for logical RPC channels carried by the current transport. */
export interface ClientConnectionRpc {
  /**
   * Call one endpoint through an already registered logical channel.
   * @param channel - absolute logical channel such as `/api`.
   * @param endpoint - channel-relative endpoint such as `goals/create`.
   * @param payload - channel-owned request payload.
   * @param signal - optional caller cancellation.
   * @returns the existing RPC success/error result; correlation stays inside Connection.
   */
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<RpcResult<unknown>>
}
