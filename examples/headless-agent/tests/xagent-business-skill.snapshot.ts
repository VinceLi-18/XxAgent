import { generateKeyPairSync } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, test } from 'vitest'

const fixture = fileURLToPath(new URL('./fixtures/xagent/business-skill/', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const { privateKey } = generateKeyPairSync('ed25519')
test.each(['explicit', 'revoked'])('xagent business skill %s real-loop snapshot', async (scenario) => {
  const result = await runLoaderSmoke({ label: `xagent business skill ${scenario}`, tempDirPrefix: 'xagent-business-skill-',
    binScript: join(fixture, 'driver.ts'), libBinScript: join(fixture, 'driver.ts'), configPath: join(fixture, 'cordis.yml'), tsconfigPath,
    env: { XAGENT_SKILL_SCENARIO: scenario, XAGENT_SNAPSHOT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } })
  expect(result.stderr).toBe('')
  const expected = join(fixture, `${scenario}.expected.txt`)
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, result.stdout)
  expect(result.stdout).toBe(await readFile(expected, 'utf8'))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
