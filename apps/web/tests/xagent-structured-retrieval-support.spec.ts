import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './support.ts'
import {
  browserDiagnosticUrl,
  redactBrowserDiagnosticText,
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

  it('removes query tokens and bearer-like values from browser diagnostics', () => {
    expect(browserDiagnosticUrl('http://127.0.0.1:8765/content?signature=secret&token=secret')).toBe(
      'http://127.0.0.1:8765/content',
    )
    expect(redactBrowserDiagnosticText(
      'GET http://127.0.0.1:8765/content?signature=abc bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
    )).toBe('GET http://127.0.0.1:8765/content bearer [REDACTED]')
  })

  it('allocates no task resources when the owning E2E suite is skipped', () => {
    const root = mkdtempSync(join(tmpdir(), 'xagent-task12-collection-'))
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root }
      delete env.XAGENT_STRUCTURED_RETRIEVAL_E2E
      const collected = spawnSync(process.execPath, [
        join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'),
        'run', '--config', join(REPO_ROOT, 'vitest.web.config.ts'),
        join(REPO_ROOT, 'apps/web/tests/xagent-structured-retrieval.e2e.ts'),
      ], { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 30_000 })
      expect(collected.status, `${collected.stdout}\n${collected.stderr}`).toBe(0)
      expect(readdirSync(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
