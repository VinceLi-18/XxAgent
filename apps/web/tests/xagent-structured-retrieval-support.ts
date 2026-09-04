import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { spawn } from 'node:child_process'

/** One child process owned by the structured-retrieval acceptance world. */
export interface OwnedChildProcess {
  readonly child: ChildProcess
  readonly closed: Promise<void>
  isClosed(): boolean
}

/** Bounded TERM/KILL waits used by acceptance teardown. */
export interface StopChildOptions {
  readonly termGraceMs: number
  readonly killGraceMs: number
}

/** Stable, per-run identities used by the full-stack scenario. */
export interface StructuredRetrievalIdentity {
  readonly composeProject: string
  readonly managerEmail: string
  readonly specialistEmail: string
  readonly firstProjectName: string
  readonly secondProjectName: string
}

/** @returns Stable identities derived only from the supplied lowercase suffix. */
export function structuredRetrievalIdentity(_suffix: string): StructuredRetrievalIdentity {
  if (!/^[a-z0-9]{1,24}$/u.test(_suffix)) throw new Error('structured retrieval suffix must be 1-24 lowercase ASCII letters or digits')
  return {
    composeProject: `xagent-task12-${_suffix}`,
    managerEmail: `manager.task12.${_suffix}@example.test`,
    specialistEmail: `specialist.task12.${_suffix}@example.test`,
    firstProjectName: `Task12 Alpha ${_suffix}`,
    secondProjectName: `Task12 Beta ${_suffix}`,
  }
}

/** @returns A child handle whose settlement follows the process `close` event. */
export function spawnOwnedChild(_command: string, _args: readonly string[], _options: SpawnOptions): OwnedChildProcess {
  const child = spawn(_command, [..._args], _options)
  let closed = false
  const closeSettlement = new Promise<void>((resolve) => {
    child.once('close', () => {
      closed = true
      resolve()
    })
  })
  return { child, closed: closeSettlement, isClosed: () => closed }
}

/** @returns A Promise that settles only after the owned process closes. */
export async function stopChildProcess(
  _owned: OwnedChildProcess | undefined,
  _options?: StopChildOptions,
): Promise<void> {
  if (_owned === undefined || _owned.isClosed()) return
  const options = _options ?? { termGraceMs: 5_000, killGraceMs: 5_000 }
  if (_owned.child.exitCode === null && _owned.child.signalCode === null) _owned.child.kill('SIGTERM')
  if (await settlesWithin(_owned.closed, options.termGraceMs)) return
  if (_owned.child.exitCode === null && _owned.child.signalCode === null) _owned.child.kill('SIGKILL')
  if (await settlesWithin(_owned.closed, options.killGraceMs)) return
  throw new Error(`structured-retrieval child ${String(_owned.child.pid ?? 'unknown')} did not close before its stop deadline`)
}

async function settlesWithin(settled: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => { resolve(false) }, timeoutMs)
    timeout.unref()
    void settled.then(() => {
      clearTimeout(timeout)
      resolve(true)
    })
  })
}

/** @returns A diagnostic HTTP URL with every query field removed. */
export function browserDiagnosticUrl(_value: string): string {
  try {
    const url = new URL(_value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'non-HTTP URL'
    return `${url.origin}${url.pathname}`
  } catch {
    return 'invalid URL'
  }
}

/** @returns Diagnostic text with URL queries and bearer-like secrets removed. */
export function redactBrowserDiagnosticText(_value: string): string {
  return _value
    .replace(/https?:\/\/[^\s"'<>]+/gu, value => browserDiagnosticUrl(value))
    .replace(/\b(?:bearer\s+)?eyJ[a-z0-9_-]+(?:\.[a-z0-9_-]+){1,2}\b/giu, 'bearer [REDACTED]')
}
