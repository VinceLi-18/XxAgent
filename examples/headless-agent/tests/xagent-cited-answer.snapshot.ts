import { generateKeyPairSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./fixtures/xagent/retrieval/', import.meta.url))
const configPath = join(fixtureDir, 'cordis.yml')
const binScript = join(fixtureDir, 'driver.ts')
const expectedPath = join(fixtureDir, 'cited-answer.expected.jsonl')
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const { privateKey } = generateKeyPairSync('ed25519')

describe('XAgent cited-answer Loader snapshot', () => {
  it('projects the request-owned terminal tool and canonical result through a runnable composition', async () => {
    const result = await runLoaderSmoke({
      label: 'XAgent cited-answer snapshot',
      tempDirPrefix: 'xagent-cited-answer-',
      binScript,
      libBinScript: binScript,
      configPath,
      tsconfigPath,
      env: { XAGENT_SNAPSHOT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    })

    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(await readFile(expectedPath, 'utf8'))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
