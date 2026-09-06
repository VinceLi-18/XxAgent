import { existsSync, globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const xagentRepositoryUrl = 'git+https://github.com/VinceLi-18/XxAgent.git'
const workspaceManifestPatterns = [
  'package.json',
  'vendor/*/package.json',
  'packages/*/*/package.json',
  'native/landlock-run/package.json',
  'native/landlock-run/packages/*/package.json',
  'apps/*/package.json',
  'website/package.json',
  'examples/package.json',
  'python/sdk-runtime/package.json',
] as const
const removedReleaseWorkflows = [
  '.github/workflows/release.yml',
  '.github/workflows/release-vendor.yml',
  '.github/workflows/landlock-run-release.yml',
  '.github/workflows/python-release.yml',
] as const

interface PackageManifest {
  name?: string
  private?: boolean
  publishConfig?: unknown
  repository?: {
    type?: string
    url?: string
    directory?: string
  }
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as PackageManifest
}

describe('private application distribution', () => {
  it('keeps every JavaScript workspace package private and source-owned by XxAgent', () => {
    const manifests = globSync([...workspaceManifestPatterns], { cwd: root }).sort()

    expect(manifests.length).toBeGreaterThan(200)
    for (const path of manifests) {
      const manifest = readManifest(path)
      expect(manifest.private, `${path} must be private`).toBe(true)
      expect(manifest.publishConfig, `${path} must not configure registry publication`).toBeUndefined()
      if (path === 'package.json') continue
      expect(manifest.repository, `${path} must identify the private source repository`).toEqual({
        type: 'git',
        url: xagentRepositoryUrl,
        directory: path.slice(0, -'/package.json'.length),
      })
    }
  })

  it('resolves every internal dependency from the merged workspace', () => {
    const manifests = globSync([...workspaceManifestPatterns], { cwd: root }).sort()
    const entries = manifests.map(path => ({ path, manifest: readManifest(path) }))
    const internalNames = new Set(entries.flatMap(({ manifest }) => manifest.name ? [manifest.name] : []))
    const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

    for (const { path, manifest } of entries) {
      for (const section of sections) {
        for (const [name, range] of Object.entries(manifest[section] ?? {})) {
          if (name.startsWith('@deepseek-ai/') || name.startsWith('@xagent/')) {
            expect(internalNames.has(name), `${path} ${section}.${name} must exist in the merged workspace`).toBe(true)
          }
          if (!internalNames.has(name)) continue
          expect(range, `${path} ${section}.${name} must resolve from this workspace`).toMatch(/^workspace:/)
        }
      }
    }
  })

  it('exposes no package-registry publication entry point', () => {
    for (const path of removedReleaseWorkflows) {
      expect(existsSync(resolve(root, path)), `${path} must be removed`).toBe(false)
    }
    expect(globSync('scripts/release/*', { cwd: root })).toEqual([])
    expect(existsSync(resolve(root, 'scripts/publish-npm-baseline.ts'))).toBe(false)
    expect(existsSync(resolve(root, 'native/landlock-run/scripts/publish-release.mjs'))).toBe(false)

    const rootManifest = readManifest('package.json')
    expect(Object.keys(rootManifest.scripts ?? {}).filter(name => (
      name === 'publish:npm-baseline' || name.startsWith('release:')
    ))).toEqual([])

    const nativeManifest = readManifest('native/landlock-run/package.json')
    expect(Object.keys(nativeManifest.scripts ?? {}).filter(name => name.includes('publish'))).toEqual([])

    const workflowText = globSync('.github/workflows/*.{yml,yaml}', { cwd: root })
      .map(path => readFileSync(resolve(root, path), 'utf8'))
      .join('\n')
    expect(workflowText).not.toContain('https://registry.npmjs.org')
    expect(workflowText).not.toContain('pypa/gh-action-pypi-publish')
    expect(workflowText).not.toMatch(/\bnpm publish\b/)

    const gitlabWorkflow = readFileSync(resolve(root, '.gitlab-ci.yml'), 'utf8')
    expect(gitlabWorkflow).not.toMatch(/\btwine upload\b/)
    expect(gitlabWorkflow).not.toContain('TWINE_REPOSITORY_URL')
  })

  it('identifies XxAgent as the source of both private Python carriers', () => {
    for (const path of ['python/sdk/pyproject.toml', 'python/sdk-runtime/pyproject.toml']) {
      const content = readFileSync(resolve(root, path), 'utf8')
      expect(content, `${path} must identify XxAgent`).toContain('https://github.com/VinceLi-18/XxAgent')
      expect(content, `${path} must not identify the former DSH repository`).not.toContain('github.com/deepseek-ai/deepseek-harness')
    }
  })

  it('identifies XxAgent on application-owned runtime and documentation surfaces', () => {
    const ownedSurfaces = [
      'packages/llm/llm/src/attribution.ts',
      'packages/client/connection/src/client/fixture.ts',
      'packages/skill/skill-badge/assets/dsh-badge.md',
      'scripts/project-doc-site.ts',
      'scripts/translation-pairing.ts',
      'website/.vitepress/config.ts',
    ] as const

    for (const path of ownedSurfaces) {
      const content = readFileSync(resolve(root, path), 'utf8')
      expect(content, `${path} must identify XxAgent`).toContain('github.com/VinceLi-18/XxAgent')
      expect(content, `${path} must not identify the former DSH repository`).not.toContain(
        'github.com/deepseek-ai/deepseek-harness',
      )
    }
  })
})
