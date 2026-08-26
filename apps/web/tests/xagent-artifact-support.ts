import type { ChildProcess } from 'node:child_process'

/** 资料 E2E 子进程停止等待参数。 */
export interface StopChildOptions {
  /** 发送 SIGTERM 后等待退出的毫秒数。 */
  readonly termGraceMs: number
  /** 发送 SIGKILL 后等待关闭的毫秒数。 */
  readonly killGraceMs: number
}

const DEFAULT_STOP_OPTIONS: StopChildOptions = {
  termGraceMs: 5_000,
  killGraceMs: 5_000,
}

/**
 * 停止资料 E2E 拥有的子进程。
 * @param child - 测试启动的 DSH 子进程。
 * @param options - TERM 与 KILL 的有界等待时间。
 * @returns 子进程停止后的 Promise。
 */
export async function stopChildProcess(
  child: ChildProcess | undefined,
  options: StopChildOptions = DEFAULT_STOP_OPTIONS,
): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
  child.kill('SIGTERM')
  if (await settlesWithin(closed, options.termGraceMs)) return
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  if (await settlesWithin(closed, options.killGraceMs)) return
  throw new Error(`DSH 子进程 ${String(child.pid ?? '未知')} 在 SIGKILL 后仍未关闭`)
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
