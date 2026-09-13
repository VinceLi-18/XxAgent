import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { withFileLock } from '../src/index.ts'

const fault = vi.hoisted(() => ({ remaining: 0, code: 'EPERM' }))

// Inject only the kernel open failure; successful acquisition and writes use real files.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: (async (path: unknown, ...rest: never[]) => {
      if (String(path).endsWith('.lock') && fault.remaining > 0) {
        fault.remaining -= 1
        throw Object.assign(new Error('injected lock open failure'), { code: fault.code })
      }
      return (actual.writeFile as (path: unknown, ...args: never[]) => Promise<void>)(path, ...rest)
    }) as typeof actual.writeFile,
  }
})

let directory: string | undefined

afterEach(async () => {
  fault.remaining = 0
  fault.code = 'EPERM'
  vi.restoreAllMocks()
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

it('acquires the Windows writer lock after a transient EPERM without stealing the existing lock', async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-lock-errors-'))
  const target = join(directory, 'document')
  const lock = `${target}.lock`
  await writeFile(lock, 'other writer')
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  fault.remaining = 1
  let entered = false
  const writing = withFileLock(target, async () => {
    entered = true
    await writeFile(target, 'committed')
    return 7
  })
  const result = writing.then(value => ({ value }), (error: unknown) => ({ error }))
  await new Promise(resolve => setTimeout(resolve, 70))
  expect(entered).toBe(false)
  expect(await readFile(lock, 'utf8')).toBe('other writer')
  await rm(lock)
  expect(await result).toEqual({ value: 7 })
  expect(await readFile(target, 'utf8')).toBe('committed')
  await expect(readFile(lock)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('returns persistent Windows EPERM at the acquisition deadline without running the operation', async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-lock-errors-'))
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  fault.remaining = Number.POSITIVE_INFINITY
  let entered = false
  const started = Date.now()
  await expect(withFileLock(join(directory, 'document'), async () => { entered = true }))
    .rejects.toMatchObject({ code: 'EPERM' })
  expect(Date.now() - started).toBeGreaterThanOrEqual(2_000)
  expect(entered).toBe(false)
})

it.each([['linux', 'EPERM'], ['win32', 'ENOSPC']] as const)(
  'does not retry %s %s as lock contention', async (platform, code) => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-lock-errors-'))
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    fault.code = code
    fault.remaining = 1
    let entered = false
    await expect(withFileLock(join(directory, 'document'), async () => { entered = true }))
      .rejects.toMatchObject({ code })
    expect(entered).toBe(false)
  },
)
