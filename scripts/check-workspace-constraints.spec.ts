import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { privateXagentPackages } from './check-workspace-constraints.ts'

const root = resolve(import.meta.dirname, '..')
const xagentRepositoryUrl = 'git+https://github.com/VinceLi-18/XxAgent.git'

interface PackageManifest {
  name: string
  private?: boolean
  publishConfig?: unknown
  repository?: {
    type?: string
    url?: string
    directory?: string
  }
}

function readManifest(directory: string): PackageManifest {
  return JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8')) as PackageManifest
}

describe('private XAgent package policy', () => {
  it('registers every fork-owned runtime package explicitly', () => {
    const packageDirectories = readdirSync(join(root, 'packages/xagent'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => `packages/xagent/${entry.name}`)
    const expectedDirectories = [
      'packages/bundle/xagent-business',
      'packages/bundle/xagent-developer',
      ...packageDirectories,
    ].sort()

    expect(Object.keys(privateXagentPackages).sort()).toEqual(expectedDirectories)

    for (const directory of expectedDirectories) {
      const manifest = readManifest(directory)

      expect(privateXagentPackages[directory]).toBe(manifest.name)
      expect(manifest.private).toBe(true)
      expect(manifest.publishConfig).toBeUndefined()
      expect(manifest.repository).toEqual({
        type: 'git',
        url: xagentRepositoryUrl,
        directory,
      })
    }
  })
})
