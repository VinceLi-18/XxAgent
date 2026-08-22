/** Validate the XAgent business bundle's static, deny-by-default patch. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

interface PatchRow {
  id?: string
  disabled?: boolean
  config?: Record<string, unknown>
}

interface EntryPatch extends PatchRow {
  insert?: PatchRow[]
}

interface JsExpression {
  __jsExpr: string
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
      .map(row => [row.id, row.config]),
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

  it('anchors every local state provider to the current Profile data directory', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const patch = loadPatch(resolve(root, 'cordis.patch.yml'))

    expect(readXagentStatePatches(patch)).toEqual({
      settings: { dshHome: { __jsExpr: 'dshProfileDataPath()' } },
      credentials: { dshHome: { __jsExpr: 'dshProfileDataPath()' } },
      'session-persistence-jsonl': { root: { __jsExpr: "dshProfileDataPath('sessions')" } },
      'attachment-local': { dshHome: { __jsExpr: 'dshProfileDataPath()' } },
      'storage-json': { root: { __jsExpr: "dshProfileDataPath('storages')" } },
    })
  })
})
