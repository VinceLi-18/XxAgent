import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  browserDiagnosticUrl,
  redactBrowserDiagnosticText,
  stopChildProcess,
} from './xagent-artifact-support.ts'

describe('XAgent 资料 E2E 辅助生命周期', () => {
  it('强制停止后等待子进程 close 再返回', async () => {
    const child = spawn(process.execPath, ['-e', [
      "process.on('SIGTERM', () => {})",
      "process.stdout.write('ready\\n')",
      'setInterval(() => {}, 1000)',
    ].join(';')], { stdio: ['ignore', 'pipe', 'pipe'] })
    let closeObserved = false
    const closed = new Promise<void>((resolve) => {
      child.once('close', () => {
        closeObserved = true
        resolve()
      })
    })
    try {
      await new Promise<void>((resolve) => { child.stdout.once('data', () => { resolve() }) })
      await stopChildProcess(child, { termGraceMs: 25, killGraceMs: 2_000 })
      expect(child.signalCode).toBe('SIGKILL')
      expect(closeObserved).toBe(true)
    } finally {
      if (!closeObserved) child.kill('SIGKILL')
      await closed
    }
  })

  it('浏览器网络诊断只保留 origin 和 pathname', () => {
    expect(browserDiagnosticUrl(
      `http://127.0.0.1:8765/api/v1/xagent/artifact-content/version?expires=1&signature=${'a'.repeat(64)}`,
    )).toBe('http://127.0.0.1:8765/api/v1/xagent/artifact-content/version')
    expect(browserDiagnosticUrl('不是 URL')).toBe('无效 URL')
    expect(redactBrowserDiagnosticText(
      `请求失败 http://127.0.0.1:8765/content?expires=1&signature=${'b'.repeat(64)}`,
    )).toBe('请求失败 http://127.0.0.1:8765/content')
  })
})
