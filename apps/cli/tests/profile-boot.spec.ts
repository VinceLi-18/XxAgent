import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProfile, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { describe, expect, it } from 'vitest'
import { runProfile } from '../src/profile-boot.ts'

/** Boot a minimal XAgent-named Profile under the supplied temporary Harness home. */
async function bootXagentProfileForTest(name: string, home: string) {
  const profileDir = resolveProfileDir(name, home)
  initProfile(profileDir, [])
  // runProfile normally mounts a real HMR service for long-lived profiles.
  // This test has no config modules to reload, so its minimal profile supplies
  // only the watcher interface that runProfile requires after boot.
  writeFileSync(join(profileDir, 'hmr.mjs'), `export default ctx => {
  ctx.provide('hmr', { registerConfig: async () => async () => {} })
}
`)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), `- insert:
    - id: hmr
      name: ./hmr.mjs
`)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await runProfile({
      environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]),
      profile: name,
      patchFiles: [],
      args: [],
    })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

describe('runProfile', () => {
  it('provides distinct current Profile data-path functions before the configuration tree starts', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-profile-boot-'))
    const business = await bootXagentProfileForTest('xagent-business', home)
    const developer = await bootXagentProfileForTest('xagent-developer', home)
    try {
      expect(business.ctx.dshProfileDataPath?.('sessions'))
        .toBe(join(home, 'profiles', 'xagent-business', 'data', 'sessions'))
      expect(developer.ctx.dshProfileDataPath?.('sessions'))
        .toBe(join(home, 'profiles', 'xagent-developer', 'data', 'sessions'))
      expect(business.ctx.dshProfileDataPath?.('sessions'))
        .not.toBe(developer.ctx.dshProfileDataPath?.('sessions'))
    } finally {
      await Promise.all([business.ctx.fiber.dispose(), developer.ctx.fiber.dispose()])
    }
  })
})
