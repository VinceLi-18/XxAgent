/** Validate the XAgent business bundle's static, deny-by-default patch. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { composeEntries, loadProfile } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

interface PatchRow {
  id?: string
  name?: string
  disabled?: boolean | null
  config?: Record<string, unknown>
}

interface EntryPatch extends PatchRow {
  insert?: PatchRow[]
}

interface JsExpression {
  __jsExpr: string
}

function readJsExpressionConfig(config: Record<string, unknown>): Record<string, JsExpression> {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || !('__jsExpr' in value) || typeof value.__jsExpr !== 'string') {
      throw new TypeError(`${key} must be a JavaScript expression`)
    }
    return [key, { __jsExpr: value.__jsExpr }]
  }))
}

const prohibitedRows = [
  'bash-sandbox',
  'pwsh-sandbox',
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'tool-str-replace-editor',
  'tool-web',
  'fs-observation-policy',
  'fs-sandbox',
  'subagent',
  'subagent-spawn-in-process',
  'subagent-fork-in-process',
  'tool-subagent',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent-fork',
  'tool-subagent-report',
  'workflow-worker-thread',
  'tool-workflow',
  'tool-skill',
  'skill-filesystem',
] as const

const disabledHostRows = ['permission', 'ui-permission'] as const

const disabledPresetRows = ['agent-presets', 'ui-agent-preset'] as const

const forbiddenBrowserFields = [
  'serviceToken',
  'userToken',
  'receipt',
  'embeddingOrigin',
  'delegationPrivateKey',
  'nonce',
  'objectKey',
  'signedUrl',
] as const

const forbiddenBrowserValues = [
  'xagent-retrieval-loader-service-token',
  'xagent-retrieval-loader-user-token',
  'receipt_private_search_1',
  'https://embedding.example.test',
  '-----BEGIN PRIVATE KEY-----',
  'retrieval-nonce-fixture',
  'private/object-key-fixture',
  'https://objects.example.test/private?sig=fixture',
] as const

interface ClientDeclaration {
  readonly inject?: string[]
  readonly immediately?: boolean
  readonly platform?: string
}

interface BrowserRow {
  readonly row: PatchRow
  readonly client: ClientDeclaration
}

const requireFromCli = createRequire(resolve(process.cwd(), 'apps/cli/package.json'))

function clientDeclaration(name: string): ClientDeclaration | undefined {
  let manifestPath: string
  try {
    manifestPath = requireFromCli.resolve(`${name}/package.json`)
  } catch {
    // Loader builtins and package subpath entries have no package-root client declaration.
    return undefined
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    readonly dsh?: { readonly client?: ClientDeclaration }
  }
  return manifest.dsh?.client?.platform === 'web' ? manifest.dsh.client : undefined
}

function effectiveBusinessBrowserRows(home: string): BrowserRow[] {
  const anchor = resolve(process.cwd(), 'apps/cli/package.json')
  const profile = loadProfile('dsh-test', 'xagent-business', anchor, home)
  const rows = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  return rows.flatMap((row) => {
    if (row.disabled === true) return []
    const client = clientDeclaration(row.name)
    return client === undefined ? [] : [{ row, client }]
  })
}

function assertNoForbiddenBrowserData(value: unknown): void {
  const failures: string[] = []
  const visit = (candidate: unknown, path: string): void => {
    if (typeof candidate === 'string') {
      for (const forbidden of forbiddenBrowserValues) {
        if (candidate.includes(forbidden)) failures.push(`${path} contains ${JSON.stringify(forbidden)}`)
      }
      return
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => { visit(item, `${path}[${String(index)}]`) })
      return
    }
    if (typeof candidate !== 'object' || candidate === null) return
    for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
      const normalized = key.replaceAll(/[-_]/gu, '').toLowerCase()
      for (const forbidden of forbiddenBrowserFields) {
        if (normalized.includes(forbidden.toLowerCase())) failures.push(`${path}.${key} uses forbidden field ${forbidden}`)
      }
      visit(item, `${path}.${key}`)
    }
  }
  visit(value, '$')
  if (failures.length > 0) throw new Error(failures.join('\n'))
}

function loadPatch(path: string): EntryPatch[] {
  const parsed = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError(`${path} must contain a patch list`)
  return parsed as EntryPatch[]
}

function readXagentStatePatches(patch: EntryPatch[]): Record<string, Record<string, JsExpression>> {
  return Object.fromEntries(
    patch
      .filter((row): row is PatchRow & { id: string; config: Record<string, unknown> } => (
        typeof row.id === 'string' && row.config !== undefined
      ))
      .map(row => [row.id, readJsExpressionConfig(row.config)]),
  )
}

describe('xagent business bundle', () => {
  it('declares a private bundle patch without the web application layer', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      name?: string
      private?: boolean
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }

    expect(manifest.name).toBe('@xagent/dsh-business')
    expect(manifest.private).toBe(true)
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies ?? {}).not.toHaveProperty('@deepseek-ai/dsh-web-app')
  })

  it('disables every prohibited base capability in the effective patch', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const base = loadPatch(resolve(root, '../base/cordis.patch.yml'))
    const business = loadPatch(resolve(root, 'cordis.patch.yml'))
    const effectiveRows = new Map<string, PatchRow>()

    for (const row of base.flatMap(patch => patch.insert ?? [])) {
      if (row.id !== undefined) effectiveRows.set(row.id, row)
    }
    for (const row of business) {
      if (row.id !== undefined) effectiveRows.set(row.id, row)
    }

    for (const id of prohibitedRows) {
      expect(effectiveRows.get(id), `${id} must exist in the shared base bundle`).toBeDefined()
      expect(effectiveRows.get(id), `${id} must be disabled for business use`).toMatchObject({ id, disabled: true })
    }
  })

  it('disables host permission rows when shell execution is unavailable', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const business = loadPatch(resolve(root, 'cordis.patch.yml'))
    const rows = new Map(business.map(row => [row.id, row]))

    for (const id of disabledHostRows) {
      expect(rows.get(id), `${id} must be explicitly disabled for business use`)
        .toMatchObject({ id, disabled: true })
    }
  })

  it('disables the agent preset roster and its browser entry', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const business = loadPatch(resolve(root, 'cordis.patch.yml'))
    const rows = new Map(business.map(row => [row.id, row]))

    for (const id of disabledPresetRows) {
      expect(rows.get(id), `${id} must be explicitly disabled for business use`)
        .toMatchObject({ id, disabled: true })
    }
  })

  it('keeps the project surface disabled while retaining the private Host registry dependency', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const business = loadPatch(resolve(root, 'cordis.patch.yml'))
    const rows = new Map(business.map(row => [row.id, row]))

    expect(rows.get('ui-workspace')).toMatchObject({ id: 'ui-workspace', disabled: true })
    expect(rows.has('workspace')).toBe(false)
  })

  it('anchors every local state provider to the current Profile data directory', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const patch = loadPatch(resolve(root, 'cordis.patch.yml'))

    expect(readXagentStatePatches(patch)).toEqual({
      settings: { dshHome: { __jsExpr: 'dshProfileDataPath()' } },
      credentials: { dshHome: { __jsExpr: 'dshProfileDataPath()' } },
      'attachment-local': { dshHome: { __jsExpr: 'dshProfileDataPath()' } },
      'storage-json': { root: { __jsExpr: "dshProfileDataPath('storages')" } },
    })
  })

  it('replaces local Session persistence with the authenticated FastAPI stack', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const patch = loadPatch(resolve(root, 'cordis.patch.yml'))
    const rows = new Map(patch.flatMap(row => row.insert ?? [row]).map(row => [row.id, row]))

    expect(rows.get('session-persistence-jsonl')).toMatchObject({ disabled: true })
    expect(rows.get('xagent-session-persistence-api')).toMatchObject({
      name: '@xagent/dsh-session-persistence-api',
    })
    expect(rows.get('xagent-connection-auth')).toMatchObject({ name: '@xagent/dsh-connection-auth' })
    expect(rows.get('xagent-authorization')).toMatchObject({ name: '@xagent/dsh-authorization' })
    expect(JSON.stringify(patch)).not.toContain("dshProfileDataPath('sessions')")
  })

  it('composes the authenticated project workbench and account browser surfaces', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const patch = loadPatch(resolve(root, 'cordis.patch.yml'))
    const rows = new Map(patch.flatMap(row => row.insert ?? [row]).map(row => [row.id, row]))

    expect(rows.get('xagent-project')).toMatchObject({
      name: '@xagent/dsh-project',
      config: {
        backendOrigin: { __jsExpr: 'process.env.XAGENT_API_ORIGIN' },
        serviceToken: { __jsExpr: 'process.env.XAGENT_SERVICE_TOKEN' },
      },
    })
    expect(rows.get('xagent-ui-project')).toMatchObject({
      name: '@xagent/dsh-ui-project',
      disabled: false,
    })
    expect(rows.get('xagent-ui-account')).toMatchObject({
      name: '@xagent/dsh-ui-account',
      disabled: false,
    })
  })

  it('composes the Artifact Host before its Browser consumer with only service endpoint configuration', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const patch = loadPatch(resolve(root, 'cordis.patch.yml'))
    const rows = patch.flatMap(row => row.insert ?? [row])
    const artifactIndex = rows.findIndex(row => row.id === 'xagent-artifact')
    const uiArtifactIndex = rows.findIndex(row => row.id === 'xagent-ui-artifact')

    expect(artifactIndex).toBeGreaterThanOrEqual(0)
    expect(uiArtifactIndex).toBeGreaterThan(artifactIndex)
    expect(rows[artifactIndex]).toEqual({
      id: 'xagent-artifact',
      name: '@xagent/dsh-artifact',
      config: {
        backendOrigin: { __jsExpr: 'process.env.XAGENT_API_ORIGIN' },
        serviceToken: { __jsExpr: 'process.env.XAGENT_SERVICE_TOKEN' },
      },
    })
    expect(rows[uiArtifactIndex]).toEqual({
      id: 'xagent-ui-artifact',
      name: '@xagent/dsh-ui-artifact',
    })
  })

  it('composes authenticated retrieval before its tools and citation Browser consumer', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const patch = loadPatch(resolve(root, 'cordis.patch.yml'))
    const rows = patch.flatMap(row => row.insert ?? [row])
    const byId = new Map(rows.map(row => [row.id, row]))
    const index = (id: string): number => rows.findIndex(row => row.id === id)

    expect(index('xagent-retrieval')).toBeGreaterThan(index('xagent-session-persistence-api'))
    expect(index('xagent-retrieval')).toBeGreaterThan(index('xagent-connection-auth'))
    expect(index('xagent-tool-retrieval')).toBeGreaterThan(index('xagent-retrieval'))
    expect(index('xagent-ui-citation')).toBeGreaterThan(index('xagent-ui-project'))
    expect(index('xagent-ui-citation')).toBeGreaterThan(index('xagent-ui-artifact'))
    expect(byId.get('xagent-retrieval')).toEqual({
      id: 'xagent-retrieval',
      name: '@xagent/dsh-retrieval',
      config: {
        backendOrigin: { __jsExpr: 'process.env.XAGENT_API_ORIGIN' },
        serviceToken: { __jsExpr: 'process.env.XAGENT_SERVICE_TOKEN' },
        delegationPrivateKey: { __jsExpr: 'process.env.XAGENT_DELEGATION_PRIVATE_KEY' },
        delegationIssuer: { __jsExpr: 'process.env.XAGENT_DELEGATION_ISSUER' },
        delegationAudience: { __jsExpr: 'process.env.XAGENT_DELEGATION_AUDIENCE' },
      },
    })
    expect(byId.get('xagent-tool-retrieval')).toEqual({
      id: 'xagent-tool-retrieval',
      name: '@xagent/dsh-tool-retrieval',
    })
    expect(byId.get('xagent-ui-citation')).toEqual({
      id: 'xagent-ui-citation',
      name: '@xagent/dsh-ui-citation',
    })
  })

  it('composes governed Fact Host, Native tool, and Browser UI only after authorization', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const patch = loadPatch(resolve(root, 'cordis.patch.yml'))
    const rows = patch.flatMap(row => row.insert ?? [row])
    const byId = new Map(rows.map(row => [row.id, row]))
    const index = (id: string): number => rows.findIndex(row => row.id === id)

    expect(index('xagent-fact')).toBeGreaterThan(index('xagent-authorization'))
    expect(index('xagent-tool-fact')).toBeGreaterThan(index('xagent-fact'))
    expect(index('xagent-ui-fact')).toBeGreaterThan(index('xagent-ui-project'))
    expect(byId.get('xagent-fact')).toEqual({
      id: 'xagent-fact',
      name: '@xagent/dsh-fact',
      config: {
        backendOrigin: { __jsExpr: 'process.env.XAGENT_API_ORIGIN' },
        serviceToken: { __jsExpr: 'process.env.XAGENT_SERVICE_TOKEN' },
        delegationPrivateKey: { __jsExpr: 'process.env.XAGENT_DELEGATION_PRIVATE_KEY' },
        delegationIssuer: { __jsExpr: 'process.env.XAGENT_DELEGATION_ISSUER' },
        delegationAudience: { __jsExpr: 'process.env.XAGENT_DELEGATION_AUDIENCE' },
      },
    })
    expect(byId.get('xagent-tool-fact')).toEqual({ id: 'xagent-tool-fact', name: '@xagent/dsh-tool-fact' })
    expect(byId.get('xagent-ui-fact')).toEqual({ id: 'xagent-ui-fact', name: '@xagent/dsh-ui-fact' })
  })

  it('keeps retrieval credentials and opaque references out of every Browser row', () => {
    const home = mkdtempSync(resolve(tmpdir(), 'xagent-business-browser-rows-'))
    try {
      const browserRows = effectiveBusinessBrowserRows(home)
      const graph = browserRows.map(({ row, client }) => ({
        id: row.name,
        inject: client.inject ?? [],
        immediately: client.immediately === true,
      }))
      expect(browserRows.map(({ row }) => row.id)).toContain('xagent-ui-citation')
      expect(browserRows.map(({ row }) => row.id)).toContain('xagent-ui-fact')
      expect(() => { assertNoForbiddenBrowserData({ rows: browserRows.map(item => item.row), graph }) }).not.toThrow()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects a nested secret added to a real citation Browser row', () => {
    const home = mkdtempSync(resolve(tmpdir(), 'xagent-business-browser-mutation-'))
    try {
      const browserRows = structuredClone(effectiveBusinessBrowserRows(home).map(item => item.row))
      const citation = browserRows.find(row => row.id === 'xagent-ui-citation')
      expect(citation, 'the mutation must target the effective citation Browser row').toBeDefined()
      if (citation === undefined) return
      citation.config = { transport: { signedUrl: '/artifact/content' } }
      expect(() => { assertNoForbiddenBrowserData(browserRows) }).toThrow(/signedUrl/u)
      citation.config = { transport: { href: 'https://objects.example.test/private?sig=fixture' } }
      expect(() => { assertNoForbiddenBrowserData(browserRows) }).toThrow(/contains/u)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps Artifact, retrieval, and Fact packages out of every shipped non-Business Profile dump', () => {
    const home = mkdtempSync(resolve(tmpdir(), 'xagent-artifact-profile-dumps-'))
    const anchor = fileURLToPath(new URL('../../../../apps/cli/package.json', import.meta.url))
    try {
      for (const profileName of ['xagent-developer', 'web', 'headless']) {
        const profile = loadProfile('dsh-test', profileName, anchor, home)
        const warnings: string[] = []
        const rows = composeEntries(profile.layers.map(layer => layer.patches), message => warnings.push(message))
        const names = rows.map(row => row.name)
        expect(names, `${profileName} Host dump`).not.toContain('@xagent/dsh-artifact')
        expect(names, `${profileName} Browser dump`).not.toContain('@xagent/dsh-ui-artifact')
        expect(names, `${profileName} retrieval provider dump`).not.toContain('@xagent/dsh-retrieval')
        expect(names, `${profileName} retrieval tools dump`).not.toContain('@xagent/dsh-tool-retrieval')
        expect(names, `${profileName} citation Browser dump`).not.toContain('@xagent/dsh-ui-citation')
        expect(names, `${profileName} Fact provider dump`).not.toContain('@xagent/dsh-fact')
        expect(names, `${profileName} Fact tool dump`).not.toContain('@xagent/dsh-tool-fact')
        expect(names, `${profileName} Fact Browser dump`).not.toContain('@xagent/dsh-ui-fact')
        expect(warnings, `${profileName} dump warnings`).toEqual([])
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('declares every XAgent runtime package as a bundle dependency', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }

    expect(manifest.dependencies).toMatchObject({
      '@xagent/dsh-authorization': 'workspace:^',
      '@xagent/dsh-artifact': 'workspace:^',
      '@xagent/dsh-backend-client': 'workspace:^',
      '@xagent/dsh-connection-auth': 'workspace:^',
      '@xagent/dsh-delegation-token': 'workspace:^',
      '@xagent/dsh-fact': 'workspace:^',
      '@xagent/dsh-principal': 'workspace:^',
      '@xagent/dsh-project': 'workspace:^',
      '@xagent/dsh-retrieval': 'workspace:^',
      '@xagent/dsh-session-persistence-api': 'workspace:^',
      '@xagent/dsh-tool-retrieval': 'workspace:^',
      '@xagent/dsh-tool-fact': 'workspace:^',
      '@xagent/dsh-ui-account': 'workspace:^',
      '@xagent/dsh-ui-artifact': 'workspace:^',
      '@xagent/dsh-ui-citation': 'workspace:^',
      '@xagent/dsh-ui-fact': 'workspace:^',
      '@xagent/dsh-ui-project': 'workspace:^',
    })
  })

  it('keeps every Artifact, retrieval, and Fact package in the CLI resolver manifest', () => {
    const manifest = JSON.parse(readFileSync(
      fileURLToPath(new URL('../../../../apps/cli/package.json', import.meta.url)),
      'utf8',
    )) as { dependencies?: Record<string, string> }

    expect(manifest.dependencies).toMatchObject({
      '@xagent/dsh-artifact': 'workspace:^',
      '@xagent/dsh-delegation-token': 'workspace:^',
      '@xagent/dsh-fact': 'workspace:^',
      '@xagent/dsh-retrieval': 'workspace:^',
      '@xagent/dsh-tool-retrieval': 'workspace:^',
      '@xagent/dsh-tool-fact': 'workspace:^',
      '@xagent/dsh-ui-artifact': 'workspace:^',
      '@xagent/dsh-ui-citation': 'workspace:^',
      '@xagent/dsh-ui-fact': 'workspace:^',
    })
  })
})
