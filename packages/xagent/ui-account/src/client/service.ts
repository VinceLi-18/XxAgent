import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** 认证后由服务器 Bootstrap 返回的账号摘要。 */
export interface XAgentAccountSummary {
  readonly id: string
  readonly email: string
  readonly role: 'manager' | 'specialist'
}

/** 账号界面读取的项目工作台最小快照。 */
export interface AccountWorkbenchState {
  readonly phase: 'empty' | 'loading' | 'ready' | 'unavailable'
  readonly account?: XAgentAccountSummary
}

/** 账号变化时清空并重新装载项目工作台的客户端接口。 */
export interface AccountWorkbenchBridge {
  readonly snapshot: HostObservable<AccountWorkbenchState>
  bootstrap(signal?: AbortSignal): Promise<void>
  reset(nextAccountId?: string): void
}

/** 登录遮罩和账号页脚共享的认证状态。 */
export interface AccountState {
  readonly phase: 'checking' | 'absent' | 'login' | 'submitting' | 'authenticated' | 'unavailable'
  readonly account?: XAgentAccountSummary
  readonly message?: string
  readonly logoutError?: string
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function csrfCookie(): string | undefined {
  for (const item of document.cookie.split(';')) {
    const [rawName, ...rest] = item.trim().split('=')
    if (rawName === 'xagent_csrf') return decodeURIComponent(rest.join('='))
  }
  return undefined
}

/** 认证状态机；项目与账号数据始终来自服务器工作台快照。 */
export class AccountController implements HostObservable<AccountState> {
  private state: AccountState = { phase: 'checking' }
  private readonly listeners = new Set<() => void>()
  private epoch = 0
  private csrfToken: string | undefined
  private operation: AbortController | undefined

  constructor(
    private readonly workbench: AccountWorkbenchBridge,
    private readonly fetcher: Fetcher = globalThis.fetch.bind(globalThis),
  ) {}

  readonly getSnapshot = (): AccountState => this.state
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 检查同源认证标识，并在已认证时装载工作台。 */
  async start(): Promise<void> {
    const [epoch, signal] = this.beginOperation()
    this.publish({ phase: 'checking' })
    let response: Response
    try {
      response = await this.fetcher('/auth/session', { credentials: 'same-origin', signal })
    } catch {
      if (epoch === this.epoch) this.publish({ phase: 'unavailable' })
      return
    }
    if (epoch !== this.epoch) return
    if (response.headers.get('x-xagent-auth') !== '1') {
      this.publish({ phase: 'absent' })
      return
    }
    if (response.status === 401) {
      this.workbench.reset(undefined)
      this.publish({ phase: 'login' })
      return
    }
    if (response.status !== 204) {
      this.publish({ phase: 'unavailable' })
      return
    }
    await this.bootstrap(epoch, signal)
  }

  /** 取消当前认证操作，清空工作台并显示登录页。 */
  resetToLogin(): void {
    this.operation?.abort()
    this.operation = undefined
    ++this.epoch
    this.csrfToken = undefined
    this.workbench.reset(undefined)
    this.publish({ phase: 'login' })
  }

  /** 取消请求并停止向现有订阅者发布状态。 */
  dispose(): void {
    this.operation?.abort()
    this.operation = undefined
    ++this.epoch
    this.listeners.clear()
  }

  /**
   * 使用邮箱和密码建立同源登录会话。
   * @param email 管理员分配的邮箱。
   * @param password 当前账号密码。
   */
  async login(email: string, password: string): Promise<void> {
    const [epoch, signal] = this.beginOperation()
    this.publish({ phase: 'submitting' })
    try {
      const response = await this.fetcher('/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (epoch !== this.epoch) return
      if (!response.ok) {
        this.publish({ phase: 'login', message: response.status === 401 ? '邮箱或密码错误' : '登录服务暂时不可用' })
        return
      }
      const value: unknown = await response.json()
      if (typeof value !== 'object' || value === null || typeof (value as Record<string, unknown>).csrf_token !== 'string') {
        this.publish({ phase: 'login', message: '登录服务暂时不可用' })
        return
      }
      this.csrfToken = (value as { csrf_token: string }).csrf_token
      this.workbench.reset(undefined)
      await this.bootstrap(epoch, signal)
    } catch {
      if (epoch === this.epoch) this.publish({ phase: 'login', message: '登录服务暂时不可用' })
    }
  }

  /** 使用同源 Cookie 和 CSRF token 注销当前账号。 */
  async logout(): Promise<void> {
    if (this.state.phase !== 'authenticated') return
    const account = this.state.account
    const [epoch, signal] = this.beginOperation()
    this.publish({ phase: 'authenticated', ...(account === undefined ? {} : { account }) })
    try {
      const token = csrfCookie() ?? this.csrfToken
      const response = await this.fetcher('/auth/logout', {
        method: 'POST', credentials: 'same-origin',
        signal,
        headers: token === undefined ? {} : { 'x-xagent-csrf': token },
      })
      if (epoch !== this.epoch) return
      if (response.status !== 204 && response.status !== 401) {
        this.publish({ phase: 'authenticated', ...(account === undefined ? {} : { account }), logoutError: '退出服务暂时不可用' })
        return
      }
      this.resetToLogin()
    } catch {
      if (epoch === this.epoch) {
        this.publish({ phase: 'authenticated', ...(account === undefined ? {} : { account }), logoutError: '退出服务暂时不可用' })
      }
    }
  }

  private async bootstrap(epoch: number, signal: AbortSignal): Promise<void> {
    try {
      await this.workbench.bootstrap(signal)
      if (epoch !== this.epoch) return
      const snapshot = this.workbench.snapshot.getSnapshot()
      if (snapshot.phase !== 'ready' || snapshot.account === undefined) throw new Error('workbench unavailable')
      this.publish({ phase: 'authenticated', account: snapshot.account })
    } catch {
      if (epoch === this.epoch) this.publish({ phase: 'unavailable' })
    }
  }

  private publish(state: AccountState): void {
    this.state = state
    this.listeners.forEach((listener) => { listener() })
  }

  private beginOperation(): readonly [number, AbortSignal] {
    this.operation?.abort()
    const operation = new AbortController()
    this.operation = operation
    return [++this.epoch, operation.signal]
  }
}
