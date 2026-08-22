import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {} from '../src/profile-boot.ts'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const basePatch = join(repoRoot, 'packages/bundle/base/cordis.patch.yml')
const webPatch = join(repoRoot, 'packages/bundle/web-app/cordis.patch.yml')
const businessPatch = join(repoRoot, 'packages/bundle/xagent-business/cordis.patch.yml')
const shippedPresets = join(repoRoot, 'apps/cli/config/agent-presets')
const installAnchor = join(repoRoot, 'apps/cli/package.json')

async function bootBusiness(home: string): Promise<Context> {
  const profileDir = join(home, 'profiles', 'xagent-business')
  mkdirSync(profileDir, { recursive: true })
  const rootConfig = join(profileDir, 'cordis.yml')
  writeFileSync(rootConfig, '[]\n')
  healProfilesModuleFallback(installAnchor, home)
  const patches: PatchOptions[] = [
    ...loadOverlayPatches('dsh-test', basePatch),
    ...loadOverlayPatches('dsh-test', webPatch),
    ...loadOverlayPatches('dsh-test', businessPatch),
    {
      id: 'agent-presets',
      config: {
        default: 'standard',
        roots: [{ path: shippedPresets, trust: 'system' }],
      },
    },
    { id: 'webserver', disabled: true },
    { id: 'web-runtime', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'modules', disabled: true },
    { id: 'connection', disabled: true },
    { id: 'client-hmr', disabled: true },
    { id: 'directory-picker', disabled: true },
    { insert: [
      { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    ] },
  ]
  return await boot('dsh-test', rootConfig, patches, (ctx) => {
    ctx.provide('dshProfileDataPath', (...segments: string[]) => join(profileDir, 'data', ...segments))
    provideCmdline(ctx, { args: [], exit: () => {} })
  })
}

describe('the XAgent Business session composition', () => {
  const previousHome = process.env.DSH_HOME
  let home: string
  let project: string
  let ctx: Context | undefined

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'xagent-business-rosterless-'))
    project = join(home, 'project')
    const skillDir = join(project, '.agents', 'skills', 'business-leak-proof')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: business-leak-proof
description: Must remain invisible to the Business profile.
---

This project skill must not enter a Business session.
`)
    const userPresetDir = join(home, '.agent-presets', 'business-user-preset')
    mkdirSync(userPresetDir, { recursive: true })
    writeFileSync(join(userPresetDir, 'agent.cordis.yml'), '[]\n')
    process.env.DSH_HOME = home
    ctx = await bootBusiness(home)
  }, 120_000)

  afterAll(async () => {
    try {
      await ctx?.fiber.dispose()
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('exposes neither shipped nor user-authored agent presets', async () => {
    if (ctx === undefined) throw new Error('Business composition did not boot')
    const presets = await ctx.apiProxy.agentPresets.list({
      rpcId: RpcId('xagent-business-presets'),
      payload: {},
    })

    expect(presets.result).toEqual({
      ok: true,
      value: { presets: [], authorable: false, hasDocument: false },
    })
  })

  it('creates a rosterless session without preset tools or file skills', async () => {
    if (ctx === undefined) throw new Error('Business composition did not boot')
    const sessionId = SessionId(`xagent-business-rosterless-${randomUUID()}`)
    const created = await ctx.apiProxy.sessions.create({
      rpcId: RpcId('xagent-business-create'),
      payload: { sessionId, cwd: project },
    })

    expect(created.result).toEqual({ ok: true, value: { sessionId } })
    const agent = ctx.agents.get(sessionId)
    expect(agent).toBeDefined()
    if (agent === undefined) throw new Error('Business session was not published')
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).toEqual([])

    const skills = await ctx.apiProxy.skills.list({
      rpcId: RpcId('xagent-business-skills'),
      payload: { sessionId },
    })
    expect(skills.result).toEqual({ ok: true, value: { skills: [] } })
  })

  it('rejects an explicitly requested user preset without publishing a session', async () => {
    if (ctx === undefined) throw new Error('Business composition did not boot')
    const sessionId = SessionId(`xagent-business-explicit-${randomUUID()}`)
    const created = await ctx.apiProxy.sessions.create({
      rpcId: RpcId('xagent-business-explicit-create'),
      payload: { sessionId, cwd: project, agentPreset: 'business-user-preset' },
    })

    expect(ctx.agents.get(sessionId) === undefined).toBe(true)
    expect(ctx.sessions.get(sessionId) === undefined).toBe(true)
    expect(created.result).toEqual({
      ok: false,
      error: {
        code: 'agent-preset-not-found',
        message: 'this deployment composes no agent presets',
        details: { agentPreset: 'business-user-preset', available: [] },
      },
    })
  })

  it('rejects selecting a user preset for a blank rosterless session', async () => {
    if (ctx === undefined) throw new Error('Business composition did not boot')
    const sessionId = SessionId(`xagent-business-select-${randomUUID()}`)
    const created = await ctx.apiProxy.sessions.create({
      rpcId: RpcId('xagent-business-select-create'),
      payload: { sessionId, cwd: project },
    })
    expect(created.result).toEqual({ ok: true, value: { sessionId } })

    const selected = await ctx.apiProxy.agentPresets.select({
      rpcId: RpcId('xagent-business-select'),
      payload: { sessionId, agentPreset: 'business-user-preset' },
    })
    expect(selected.result).toEqual({
      ok: false,
      error: {
        code: 'agent-preset-not-found',
        message: 'this deployment composes no agent presets',
        details: { agentPreset: 'business-user-preset', available: [] },
      },
    })
    const agent = ctx.agents.get(sessionId)
    expect(agent).toBeDefined()
    if (agent === undefined) throw new Error('Blank Business session was not published')
    expect(agent.session.header.agentPreset).toBeUndefined()
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).toEqual([])
    const skills = await ctx.apiProxy.skills.list({
      rpcId: RpcId('xagent-business-select-skills'),
      payload: { sessionId },
    })
    expect(skills.result).toEqual({ ok: true, value: { skills: [] } })
  })
})
