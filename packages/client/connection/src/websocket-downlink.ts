/** Host-side WebSocket carrier for the two server-to-browser event streams. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import type {
  ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ConnectionRequestContextResolver, ResolvedConnectionRequestContext } from './rpc.ts'

type Frame = MuxFrame | HostFrame

function serverRequest(frame: RpcRequest<Frame>): ServerRequest {
  return {
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
  }
}

function send(socket: WebSocket, frame: RpcRequest<Frame>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('websocket downlink closed before frame delivery'))
      return
    }
    socket.send(JSON.stringify(serverRequest(frame)), (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function failureFrame(error: unknown): RpcRequest<Frame> {
  return {
    rpcId: RpcId(randomUUID()),
    payload: {
      type: 'stream/error',
      error: { code: 'internal', message: String(error), details: {} },
    },
  }
}

/**
 * Owns WebSocket negotiation and frame pumping for the connection plugin's
 * two downlinks. Client messages are a protocol violation: upstream traffic
 * remains on HTTP.
 */
export class WebSocketDownlinks {
  private readonly server = new WebSocketServer({ noServer: true })
  private readonly pumps = new Set<Promise<void>>()

  /** @param api - host API supplying the typed event streams. */
  constructor(
    private readonly api: ApiProxy,
    private readonly resolver: () => ConnectionRequestContextResolver | undefined = () => undefined,
  ) {}

  /**
   * Upgrade one socket and pump the mux stream until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - Raw socket transferred by the HTTP server.
   * @param head - Bytes already read after the upgrade headers.
   */
  handleMux(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    return this.upgrade(req, socket, head, signal => this.api.events.mux({
      rpcId: RpcId(randomUUID()),
      payload: {},
    }, signal))
  }

  /**
   * Upgrade one socket and pump the host stream until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - Raw socket transferred by the HTTP server.
   * @param head - Bytes already read after the upgrade headers.
   */
  handleHost(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    return this.upgrade(req, socket, head, signal => this.api.events.host({
      rpcId: RpcId(randomUUID()),
      payload: {},
    }, signal))
  }

  /**
   * Terminate owned sockets and await the no-server acceptor plus frame pumps.
   * @returns A promise resolving after every socket and source iterator stops.
   */
  async close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    await Promise.all(this.pumps)
  }

  private async upgrade<F extends Frame>(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    open: (signal: AbortSignal) => AsyncIterable<RpcRequest<F>>,
  ): Promise<void> {
    const activeResolver = this.resolver()
    const connectionAbort = new AbortController()
    let resolved: ResolvedConnectionRequestContext | undefined
    if (activeResolver !== undefined) {
      const connectionId = randomUUID()
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value)
        else if (Array.isArray(value)) headers.set(name, value.join(', '))
      }
      const abort = (): void => { connectionAbort.abort() }
      socket.once('close', abort)
      socket.once('error', abort)
      try {
        resolved = await activeResolver.resolve(new Request(
          new URL(req.url ?? '/', 'http://dsh.internal'),
          { headers, signal: connectionAbort.signal },
        ), connectionId, connectionAbort.signal)
      } catch {
        connectionAbort.abort()
        rejectWebSocketAuthentication(socket)
        return
      } finally {
        socket.off('close', abort)
        socket.off('error', abort)
      }
    }
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      const abort = new AbortController()
      const close = (): void => {
        abort.abort()
        connectionAbort.abort()
      }
      websocket.once('close', close)
      websocket.once('error', close)
      const expire = (): void => { websocket.close(1008, 'authentication expired') }
      resolved?.lifetime?.addEventListener('abort', expire, { once: true })
      if (resolved?.lifetime?.aborted === true) expire()
      websocket.once('message', () => {
        websocket.close(1008, 'downlink only')
      })
      const pump = this.pump(websocket, open(abort.signal), abort)
      this.pumps.add(pump)
      void pump.then(() => { this.pumps.delete(pump) })
    })
  }

  private async pump<F extends Frame>(
    socket: WebSocket,
    frames: AsyncIterable<RpcRequest<F>>,
    abort: AbortController,
  ): Promise<void> {
    try {
      for await (const frame of frames) await send(socket, frame)
    } catch (error) {
      if (!abort.signal.aborted) {
        try {
          await send(socket, failureFrame(error))
        } catch {
          // Socket loss won the race; no downstream remains to receive the failure frame.
        }
      }
    } finally {
      abort.abort()
      if (socket.readyState === WebSocket.OPEN) socket.close()
    }
  }
}

/**
 * Reject an untrusted upgrade before protocol negotiation.
 * @param socket - Raw HTTP socket that remains owned by the caller.
 */
export function rejectWebSocketUpgrade(socket: Duplex): void {
  socket.end([
    'HTTP/1.1 403 Forbidden',
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Length: 9',
    '',
    'forbidden',
  ].join('\r\n'))
}

function rejectWebSocketAuthentication(socket: Duplex): void {
  socket.end([
    'HTTP/1.1 401 Unauthorized',
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Length: 15',
    '',
    'unauthenticated',
  ].join('\r\n'))
}
