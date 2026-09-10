import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { REPO_ROOT } from './support.ts'
import {
  FactE2eResourceOwner,
  factApprovalIdentity,
  factBrowserDiagnosticUrl,
  factComposeOverride,
  factTrafficObserver,
  redactFactBrowserDiagnosticText,
  restartFactService,
  switchFactAccount,
} from './xagent-fact-support.ts'

describe('XAgent Fact Browser E2E ownership', () => {
  it('allocates no task resources when the owning E2E suite is skipped', () => {
    const root = mkdtempSync(join(tmpdir(), 'xagent-phase4b-collection-'))
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root }
      delete env.XAGENT_FACT_APPROVAL_E2E
      const collected = spawnSync(process.execPath, [
        join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'),
        'run', '--config', join(REPO_ROOT, 'vitest.web.config.ts'),
        join(REPO_ROOT, 'apps/web/tests/xagent-fact.e2e.ts'),
      ], { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 30_000 })
      expect(collected.status, `${collected.stdout}\n${collected.stderr}`).toBe(0)
      expect(readdirSync(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('derives every owned identity from one safe suffix', () => {
    expect(factApprovalIdentity('abc123')).toEqual({
      composeProject: 'xagent-phase4b-abc123',
      managerEmail: 'manager.phase4b.abc123@example.test',
      specialistEmail: 'specialist.phase4b.abc123@example.test',
      projectName: 'Phase 4B Fact abc123',
    })
    expect(() => factApprovalIdentity('../foreign')).toThrow(/suffix/u)
  })

  it('renders an exact Compose override for isolated real services', () => {
    expect(factComposeOverride({
      apiImage: 'xagent-api:test',
      embeddingImage: 'xagent-embedding:test',
      apiPort: 41001,
      minioPort: 41002,
      postgresPort: 41003,
      delegationPublicKey: 'public-key',
    })).toBe([
      'services:',
      '  api:',
      '    image: xagent-api:test',
      '    environment:',
      '      PYTHONPATH: /app',
      '      MINIO_PUBLIC_ENDPOINT: 127.0.0.1:41002',
      '      XAGENT_DELEGATION_PUBLIC_KEY: public-key',
      '    ports: !override',
      '      - 127.0.0.1:41001:8000',
      '  worker:',
      '    image: xagent-api:test',
      '    environment:',
      '      PYTHONPATH: /app',
      '  roles:',
      '    image: xagent-api:test',
      '    environment:',
      '      PYTHONPATH: /app',
      '  migrate:',
      '    image: xagent-api:test',
      '    environment:',
      '      PYTHONPATH: /app',
      '  embedding:',
      '    image: xagent-embedding:test',
      '  minio:',
      '    ports: !override',
      '      - 127.0.0.1:41002:9000',
      '  postgres:',
      '    ports: !override',
      '      - 127.0.0.1:41003:5432',
      '',
    ].join('\n'))
  })

  it('stops a live service before starting its replacement', async () => {
    const calls: string[] = []
    const replacement = await restartFactService('old', async (value) => {
      calls.push(`stop:${value}`)
    }, async () => {
      calls.push('start')
      return 'new'
    })
    expect(replacement).toBe('new')
    expect(calls).toEqual(['stop:old', 'start'])
  })

  it('logs out before authenticating the next account', async () => {
    const calls: string[] = []
    await switchFactAccount({
      logout: async () => { calls.push('logout') },
      login: async (email) => { calls.push(`login:${email}`) },
    }, 'specialist.phase4b.abc123@example.test', 'not-recorded')
    expect(calls).toEqual(['logout', 'login:specialist.phase4b.abc123@example.test'])
  })

  it('records only redacted Fact and Session HTTP observations', () => {
    const observed = factTrafficObserver()
    observed.record('POST', 'http://127.0.0.1:8765/api/xagentFact/approve?token=secret', 200)
    observed.record('POST', 'http://127.0.0.1:8765/api/session.send?receipt=secret', 409)
    observed.record('GET', 'not a URL', 503)
    expect(observed.entries()).toEqual([
      { method: 'POST', path: '/api/xagentFact/approve', status: 200 },
      { method: 'POST', path: '/api/session.send', status: 409 },
      { method: 'GET', path: 'invalid URL', status: 503 },
    ])
    expect(observed.count('/api/xagentFact/approve', 200)).toBe(1)
    expect(observed.count('invalid URL')).toBe(1)
  })

  it('removes URL queries and bearer-like values from diagnostics', () => {
    expect(factBrowserDiagnosticUrl('http://127.0.0.1:8765/content?signature=secret')).toBe(
      'http://127.0.0.1:8765/content',
    )
    expect(factBrowserDiagnosticUrl('file:///private/secret')).toBe('non-HTTP URL')
    expect(factBrowserDiagnosticUrl('not a URL')).toBe('invalid URL')
    expect(redactFactBrowserDiagnosticText(
      'GET http://127.0.0.1:8765/content?signature=abc bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
    )).toBe('GET http://127.0.0.1:8765/content bearer [REDACTED]')
  })

  it('cleans exact owned resources in reverse order and only once', async () => {
    const calls: string[] = []
    const owner = new FactE2eResourceOwner()
    owner.own('api', async () => { calls.push('api') })
    expect(() => { owner.own('api', async () => {}) }).toThrow('already owned')
    owner.own('browser', async () => { calls.push('browser') })
    await owner.dispose()
    expect(() => { owner.own('late', async () => {}) }).toThrow('is disposing')
    await owner.dispose()
    expect(calls).toEqual(['browser', 'api'])
  })

  it('attempts every cleanup and reports their exact labels', async () => {
    const owner = new FactE2eResourceOwner()
    const final = vi.fn(async () => {})
    owner.own('database', async () => { throw new Error('busy') })
    owner.own('temp root', final)
    await expect(owner.dispose()).rejects.toThrow('database: Error: busy')
    expect(final).toHaveBeenCalledOnce()
  })
})
