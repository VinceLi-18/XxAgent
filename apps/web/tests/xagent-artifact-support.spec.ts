import { describe, expect, it } from 'vitest'
import {
  browserDiagnosticUrl,
  redactBrowserDiagnosticText,
  spawnOwnedChild,
  stopChildProcess,
} from './xagent-artifact-support.ts'

describe('XAgent 资料 E2E 辅助生命周期', () => {
  it('已经 close 的子进程可重复停止', async () => {
    const owned = spawnOwnedChild(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await owned.closed
    await stopChildProcess(owned, { termGraceMs: 25, killGraceMs: 25 })
    expect(owned.isClosed()).toBe(true)
    expect(owned.child.exitCode).toBe(0)
  })

  it.skipIf(process.platform === 'win32')('POSIX 直接子进程 exit 后仍等待继承 stdio 的后代触发 close', async () => {
    const owned = spawnOwnedChild(process.execPath, ['-e', [
      "const { spawn } = require('node:child_process')",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 750)'], { stdio: ['ignore', 'inherit', 'ignore'] })",
      'process.exit(0)',
    ].join(';')], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = new Promise<void>((resolve) => { owned.child.once('exit', () => { resolve() }) })
    try {
      await exited
      expect(owned.child.exitCode).toBe(0)
      expect(owned.isClosed()).toBe(false)
      await stopChildProcess(owned, { termGraceMs: 2_000, killGraceMs: 2_000 })
      expect(owned.isClosed()).toBe(true)
    } finally {
      await owned.closed
    }
  })

  it('SIGTERM 后等待子进程 close 再返回', async () => {
    const owned = spawnOwnedChild(process.execPath, ['-e', [
      "process.stdout.write('ready\\n')",
      'setInterval(() => {}, 1000)',
    ].join(';')], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await new Promise<void>((resolve) => { owned.child.stdout?.once('data', () => { resolve() }) })
      await stopChildProcess(owned, { termGraceMs: 2_000, killGraceMs: 2_000 })
      expect(owned.child.signalCode).toBe('SIGTERM')
      expect(owned.isClosed()).toBe(true)
    } finally {
      if (!owned.isClosed()) owned.child.kill('SIGKILL')
      await owned.closed
    }
  })

  it.skipIf(process.platform === 'win32')('POSIX 强制停止后等待子进程 close 再返回', async () => {
    const owned = spawnOwnedChild(process.execPath, ['-e', [
      "process.on('SIGTERM', () => {})",
      "process.stdout.write('ready\\n')",
      'setInterval(() => {}, 1000)',
    ].join(';')], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await new Promise<void>((resolve) => { owned.child.stdout?.once('data', () => { resolve() }) })
      await stopChildProcess(owned, { termGraceMs: 25, killGraceMs: 2_000 })
      expect(owned.child.signalCode).toBe('SIGKILL')
      expect(owned.isClosed()).toBe(true)
    } finally {
      if (!owned.isClosed()) owned.child.kill('SIGKILL')
      await owned.closed
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
