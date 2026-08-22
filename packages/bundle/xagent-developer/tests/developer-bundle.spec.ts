/** Validate that the XAgent developer bundle adds no Phase 0 capabilities. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('xagent developer bundle', () => {
  it('declares a private empty patch bundle', () => {
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
    expect(patch).toEqual([])
  })
})
