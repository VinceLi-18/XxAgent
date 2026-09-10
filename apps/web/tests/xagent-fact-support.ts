import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Stable, per-run identities owned by one Fact approval Browser scenario. */
export interface FactApprovalIdentity {
  readonly composeProject: string
  readonly managerEmail: string
  readonly specialistEmail: string
  readonly projectName: string
}

/** @returns Stable identities derived only from a supplied lowercase suffix. */
export function factApprovalIdentity(suffix: string): FactApprovalIdentity {
  if (!/^[a-z0-9]{1,24}$/u.test(suffix)) {
    throw new Error('Fact approval suffix must be 1-24 lowercase ASCII letters or digits')
  }
  return {
    composeProject: `xagent-phase4b-${suffix}`,
    managerEmail: `manager.phase4b.${suffix}@example.test`,
    specialistEmail: `specialist.phase4b.${suffix}@example.test`,
    projectName: `Phase 4B Fact ${suffix}`,
  }
}

/** @returns Child process environment assembled from ambient and explicit values. */
export function factChildEnvironment(
  ambient: NodeJS.ProcessEnv,
  explicit: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
    'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'CI', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
    'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR',
  ] as const
  const child: NodeJS.ProcessEnv = {}
  for (const name of allowed) {
    const value = ambient[name]
    if (value !== undefined) child[name] = value
  }
  for (const [name, value] of Object.entries(explicit)) {
    if (value !== undefined) child[name] = value
  }
  return child
}

/** Inputs for the isolated real-service Compose override. */
export interface FactComposeOverrideInput {
  readonly apiImage: string
  readonly embeddingImage: string
  readonly apiPort: number
  readonly minioPort: number
  readonly postgresPort: number
  readonly delegationPublicKey: string
}

/** @returns A Compose override with explicit loopback ports and Fact delegation verification. */
export function factComposeOverride(input: FactComposeOverrideInput): string {
  return [
    'services:',
    '  api:',
    `    image: ${input.apiImage}`,
    '    environment:',
    '      PYTHONPATH: /app',
    `      MINIO_PUBLIC_ENDPOINT: 127.0.0.1:${String(input.minioPort)}`,
    `      XAGENT_DELEGATION_PUBLIC_KEY: ${input.delegationPublicKey}`,
    '    ports: !override',
    `      - 127.0.0.1:${String(input.apiPort)}:8000`,
    '  worker:',
    `    image: ${input.apiImage}`,
    '    environment:',
    '      PYTHONPATH: /app',
    '  roles:',
    `    image: ${input.apiImage}`,
    '    environment:',
    '      PYTHONPATH: /app',
    '  migrate:',
    `    image: ${input.apiImage}`,
    '    environment:',
    '      PYTHONPATH: /app',
    '  embedding:',
    `    image: ${input.embeddingImage}`,
    '  minio:',
    '    ports: !override',
    `      - 127.0.0.1:${String(input.minioPort)}:9000`,
    '  postgres:',
    '    ports: !override',
    `      - 127.0.0.1:${String(input.postgresPort)}:5432`,
    '',
  ].join('\n')
}

/** Stop the current service to quiescence before starting its replacement. */
export async function restartFactService<T>(
  current: T,
  stop: (current: T) => Promise<void>,
  start: () => Promise<T>,
): Promise<T> {
  await stop(current)
  return start()
}

/** Browser account actions required for an authenticated identity replacement. */
export interface FactAccountSwitcher {
  logout(): Promise<void>
  login(email: string, password: string): Promise<void>
}

/** Replace the authenticated Browser account without retaining prior account state. */
export async function switchFactAccount(
  switcher: FactAccountSwitcher,
  email: string,
  password: string,
): Promise<void> {
  await switcher.logout()
  await switcher.login(email, password)
}

/** @returns A diagnostic HTTP URL with every query field removed. */
export function factBrowserDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'non-HTTP URL'
    return `${url.origin}${url.pathname}`
  } catch {
    return 'invalid URL'
  }
}

/** @returns Diagnostic text with supplied secrets, URL queries, and bearer-like values removed. */
export function redactFactBrowserDiagnosticText(value: string, secrets: readonly string[] = []): string {
  let redacted = value
  for (const secret of secrets) {
    if (secret !== '') redacted = redacted.replaceAll(secret, '[REDACTED]')
  }
  return redacted
    .replace(/https?:\/\/[^\s"'<>]+/gu, url => factBrowserDiagnosticUrl(url))
    .replace(/\b(?:bearer\s+)?eyJ[a-z0-9_-]+(?:\.[a-z0-9_-]+){1,2}\b/giu, 'bearer [REDACTED]')
}

/** @returns Relative regular-file paths whose bytes contain the forbidden value. */
export function factFilesContaining(root: string, forbidden: string): string[] {
  if (forbidden === '') throw new Error('Fact E2E forbidden value must not be empty')
  const matches: string[] = []
  const needle = Buffer.from(forbidden)
  const visit = (path: string): void => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name))
      return
    }
    /* v8 ignore next -- the task-owned tree contains only directories, symlinks, and regular files. */
    if (!stat.isFile()) return
    if (readFileSync(path).indexOf(needle) !== -1) matches.push(relative(root, path))
  }
  visit(root)
  return matches
}

/** Secret-free observation of one Browser HTTP response. */
interface FactTrafficEntry {
  readonly method: string
  readonly path: string
  readonly status: number
}

/** In-memory observer for exact Fact and Session HTTP paths. */
export interface FactTrafficObserver {
  record(method: string, url: string, status: number): void
  entries(): readonly FactTrafficEntry[]
  count(path: string, status?: number): number
}

/** @returns A traffic observer that retains no query, body, header, or origin. */
export function factTrafficObserver(): FactTrafficObserver {
  const values: FactTrafficEntry[] = []
  return {
    record(method, url, status): void {
      let path = 'invalid URL'
      try { path = new URL(url).pathname } catch { /* A malformed diagnostic stays non-sensitive. */ }
      values.push(Object.freeze({ method, path, status }))
    },
    entries: () => values.slice(),
    count: (path, status) => values.filter(item => item.path === path && (status === undefined || item.status === status)).length,
  }
}

interface OwnedCleanup {
  readonly label: string
  readonly cleanup: () => Promise<void>
}

/** Exact reverse-order cleanup owner for one isolated Fact E2E run. */
export class FactE2eResourceOwner {
  private readonly cleanups: OwnedCleanup[] = []
  private disposal: Promise<void> | undefined

  /** Register one uniquely named resource before it becomes externally visible. */
  own(label: string, cleanup: () => Promise<void>): void {
    if (this.disposal !== undefined) throw new Error('Fact E2E resource owner is disposing')
    if (this.cleanups.some(item => item.label === label)) throw new Error(`Fact E2E resource ${label} is already owned`)
    this.cleanups.push({ label, cleanup })
  }

  /** Stop every owned resource in reverse acquisition order and aggregate failures. */
  dispose(): Promise<void> {
    return this.disposal ??= this.disposeOwned()
  }

  private async disposeOwned(): Promise<void> {
    const errors: string[] = []
    for (const item of this.cleanups.slice().reverse()) {
      try {
        await item.cleanup()
      } catch (error) {
        errors.push(`${item.label}: ${String(error)}`)
      }
    }
    if (errors.length > 0) throw new Error(errors.join('\n'))
  }
}
