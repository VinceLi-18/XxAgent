/** Validate that the XAgent developer bundle adds no Phase 0 capabilities. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

interface PatchRow {
  id?: string
  config?: Record<string, unknown>
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

function readXagentStatePatches(patch: unknown): Record<string, Record<string, JsExpression>> {
  if (!Array.isArray(patch)) throw new TypeError('patch must contain a patch list')
  return Object.fromEntries(
    (patch as PatchRow[])
      .filter((row): row is PatchRow & { id: string; config: Record<string, unknown> } => (
        typeof row.id === 'string' && row.config !== undefined
      ))
      .map(row => [row.id, readJsExpressionConfig(row.config)]),
  )
}

describe('xagent developer bundle', () => {
  it('declares a private state-isolation patch bundle without added tools', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      name?: string
      private?: boolean
      dsh?: { bundle?: { patch?: string } }
    }

    expect(manifest.name).toBe('@xagent/dsh-developer')
    expect(manifest.private).toBe(true)
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patch = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(patch)) throw new TypeError('patch must contain a patch list')
    const rows = patch as PatchRow[]
    expect(rows.map(row => row.id)).toEqual([
      'settings',
      'credentials',
      'session-persistence-jsonl',
      'attachment-local',
      'storage-json',
    ])
    expect(readXagentStatePatches(rows)).toEqual({
      settings: { dshHome: { __jsExpr: 'dshProfileDataPath()' } },
      credentials: { dshHome: { __jsExpr: 'dshProfileDataPath()' } },
      'session-persistence-jsonl': { root: { __jsExpr: "dshProfileDataPath('sessions')" } },
      'attachment-local': { dshHome: { __jsExpr: 'dshProfileDataPath()' } },
      'storage-json': { root: { __jsExpr: "dshProfileDataPath('storages')" } },
    })
  })
})
