import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { spawn } from 'node:child_process'

/** Task10 E2E 启动并持续跟踪至 close 的子进程。 */
export interface OwnedChildProcess {
  /** Node 子进程句柄。 */
  readonly child: ChildProcess
  /** stdio 与继承资源都已收敛时完成。 */
  readonly closed: Promise<void>
  /** @returns 是否已经收到 close 事件。 */
  isClosed(): boolean
}

/** 资料 E2E 子进程停止等待参数。 */
export interface StopChildOptions {
  /** 发送 SIGTERM 后等待 close 的毫秒数。 */
  readonly termGraceMs: number
  /** 发送 SIGKILL 后等待 close 的毫秒数。 */
  readonly killGraceMs: number
}

const DEFAULT_STOP_OPTIONS: StopChildOptions = {
  termGraceMs: 5_000,
  killGraceMs: 5_000,
}

/**
 * 解析资料浏览器验收的模型联网策略。
 * @param environment - 测试进程环境。
 * @returns 传给 Compose 的 Hugging Face 离线布尔字符串。
 */
export function resolveArtifactEmbeddingOffline(
  environment: Readonly<Record<string, string | undefined>>,
): 'true' | 'false' {
  const value = environment.XAGENT_TASK10_HF_HUB_OFFLINE ?? 'true'
  if (value === 'true' || value === 'false') return value
  throw new Error('XAGENT_TASK10_HF_HUB_OFFLINE 必须是 true 或 false')
}

/**
 * 解析资料浏览器验收挂载的模型缓存目录。
 * @param environment - 测试进程环境。
 * @param fallback - 未配置 CI 缓存时使用的仓库内目录。
 * @returns Compose 应挂载的主机目录。
 */
export function resolveArtifactEmbeddingCacheDir(
  environment: Readonly<Record<string, string | undefined>>,
  fallback: string,
): string {
  const configured = environment.XAGENT_EMBEDDING_CACHE_DIR
  if (configured === undefined) return fallback
  if (configured.length === 0) throw new Error('XAGENT_EMBEDDING_CACHE_DIR 不能为空')
  return configured
}

/**
 * 启动并立即跟踪 Task10 E2E 拥有的子进程。
 * @param command - 可执行文件路径。
 * @param args - 传给可执行文件的参数。
 * @param options - Node spawn 选项。
 * @returns 保存 close 结算状态的子进程所有权记录。
 */
export function spawnOwnedChild(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): OwnedChildProcess {
  const child = spawn(command, [...args], options)
  let closed = false
  const closeSettlement = new Promise<void>((resolve) => {
    child.once('close', () => {
      closed = true
      resolve()
    })
  })
  return {
    child,
    closed: closeSettlement,
    isClosed: () => closed,
  }
}

/**
 * 停止资料 E2E 拥有的子进程。
 * @param owned - 测试启动并持续跟踪的 DSH 子进程。
 * @param options - TERM 与 KILL 的有界等待时间。
 * @returns 子进程 close 后完成的 Promise。
 */
export async function stopChildProcess(
  owned: OwnedChildProcess | undefined,
  options: StopChildOptions = DEFAULT_STOP_OPTIONS,
): Promise<void> {
  if (owned === undefined || owned.isClosed()) return
  const { child, closed } = owned
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  if (await settlesWithin(closed, options.termGraceMs)) return
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  if (await settlesWithin(closed, options.killGraceMs)) return
  throw new Error(`DSH 子进程 ${String(child.pid ?? '未知')} 的 close 在停止期限内未发生`)
}

async function settlesWithin(settled: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => { resolve(false) }, timeoutMs)
    timeout.unref()
    void settled.then(() => {
      clearTimeout(timeout)
      resolve(true)
    })
  })
}

/**
 * 生成不含 signed-bearer query 的浏览器诊断地址。
 * @param value - Browser 事件给出的请求地址。
 * @returns 可进入失败消息的地址。
 */
export function browserDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '非 HTTP URL'
    return `${url.origin}${url.pathname}`
  } catch {
    return '无效 URL'
  }
}

/**
 * 移除浏览器文本诊断中 HTTP 地址的 query。
 * @param value - Console、页面错误或网络失败文本。
 * @returns 不含 HTTP query 的诊断文本。
 */
export function redactBrowserDiagnosticText(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/gu, url => browserDiagnosticUrl(url))
}
