import { Service, type Context } from '@deepseek-ai/cordis'

/** 浏览器 RPC 请求可选附加头；没有贡献者时保持原有载体。 */
export type BrowserRequestHeadersProvider = () => HeadersInit | undefined

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 当前页面插件为浏览器 RPC 提供的非敏感请求头。 */
    browserRequestHeaders: BrowserRequestHeadersService
  }
}

/** 合并浏览器 RPC 请求头并拥有贡献者生命周期。 */
export class BrowserRequestHeadersService extends Service {
  private readonly providers = new Set<BrowserRequestHeadersProvider>()

  constructor(ctx: Context) {
    super(ctx, 'browserRequestHeaders')
  }

  /** 注册一个页面生命周期内的请求头贡献者。 */
  register(provider: BrowserRequestHeadersProvider): () => void {
    this.providers.add(provider)
    return () => { this.providers.delete(provider) }
  }

  /** 合并基础请求头和当前全部贡献；贡献者不得静默覆盖已有字段。 */
  resolve(base?: HeadersInit): Headers {
    const headers = new Headers(base)
    for (const provider of this.providers) {
      const contributed = new Headers(provider())
      for (const [name, value] of contributed) {
        if (headers.has(name)) throw new Error(`browser request header ${JSON.stringify(name)} is already set`)
        headers.set(name, value)
      }
    }
    return headers
  }
}
