import { generateKeyPairSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./fixtures/xagent/fact/', import.meta.url))
const configPath = join(fixtureDir, 'cordis.yml')
const binScript = join(fixtureDir, 'driver.ts')
const expectedPath = join(fixtureDir, 'fact-approval.expected.jsonl')
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const { privateKey } = generateKeyPairSync('ed25519')

describe('XAgent fact proposal approval Loader snapshot', () => {
  it('runs evidence and reason proposals before projecting a later decision once', async () => {
    const result = await runLoaderSmoke({
      label: 'XAgent fact proposal approval snapshot',
      tempDirPrefix: 'xagent-fact-approval-',
      binScript,
      libBinScript: binScript,
      configPath,
      tsconfigPath,
      env: { XAGENT_SNAPSHOT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    })

    expect(result.stderr).toBe('')
    const transcript = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const summary = transcript.at(-1)
    expect(summary).toHaveProperty('persistenceAdmissions')
    expect(summary).not.toHaveProperty('retrievalAdmissions')
    expect(summary).not.toHaveProperty('factAdmissions')
    expect(result.stdout).toBe(await readFile(expectedPath, 'utf8'))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
