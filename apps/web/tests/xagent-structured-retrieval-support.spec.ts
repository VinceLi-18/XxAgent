import { describe, expect, it } from 'vitest'
import {
  browserDiagnosticUrl,
  redactBrowserDiagnosticText,
  spawnOwnedChild,
  stopChildProcess,
  structuredRetrievalIdentity,
} from './xagent-structured-retrieval-support.ts'

describe('XAgent structured-retrieval E2E ownership', () => {
  it('derives exact Compose labels and fixture identities from one safe suffix', () => {
    expect(structuredRetrievalIdentity('abc123')).toEqual({
      composeProject: 'xagent-task12-abc123',
      managerEmail: 'manager.task12.abc123@example.test',
      specialistEmail: 'specialist.task12.abc123@example.test',
      firstProjectName: 'Task12 Alpha abc123',
      secondProjectName: 'Task12 Beta abc123',
    })
    expect(() => structuredRetrievalIdentity('../foreign')).toThrow(/suffix/u)
  })

  it('tracks process close and waits through bounded TERM teardown', async () => {
    const owned = spawnOwnedChild(process.execPath, ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      await new Promise<void>((resolve) => { owned.child.stdout?.once('data', () => { resolve() }) })
      await stopChildProcess(owned, { termGraceMs: 2_000, killGraceMs: 2_000 })
      expect(owned.isClosed()).toBe(true)
      expect(owned.child.signalCode).toBe('SIGTERM')
    } finally {
      if (!owned.isClosed()) owned.child.kill('SIGKILL')
      await owned.closed
    }
  })

  it('waits for inherited stdio close and escalates an ignored TERM to KILL', async () => {
    const owned = spawnOwnedChild(process.execPath, ['-e', [
      "process.on('SIGTERM', () => {})",
      "process.stdout.write('ready\\n')",
      'setInterval(() => {}, 1000)',
    ].join(';')], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await new Promise<void>((resolve) => { owned.child.stdout?.once('data', () => { resolve() }) })
      await stopChildProcess(owned, { termGraceMs: 25, killGraceMs: 2_000 })
      expect(owned.isClosed()).toBe(true)
      expect(owned.child.signalCode).toBe('SIGKILL')
    } finally {
      if (!owned.isClosed()) owned.child.kill('SIGKILL')
      await owned.closed
    }
  })

  it('removes query tokens and bearer-like values from browser diagnostics', () => {
    expect(browserDiagnosticUrl('http://127.0.0.1:8765/content?signature=secret&token=secret')).toBe(
      'http://127.0.0.1:8765/content',
    )
    expect(redactBrowserDiagnosticText(
      'GET http://127.0.0.1:8765/content?signature=abc bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
    )).toBe('GET http://127.0.0.1:8765/content bearer [REDACTED]')
  })
})
