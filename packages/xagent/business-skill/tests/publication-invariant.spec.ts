import { CallId } from '@deepseek-ai/dsh-llm'
import type { SkillProviderObservation } from '@deepseek-ai/dsh-skill'
import { describe, expect, test } from 'vitest'
import { entry, request, setup } from './fixtures.ts'

// This manual diagnostic topology omits the optional invariant companion:
// provider safety must prevent publication without a diagnostic listener.

// Promise adoption resumes call() before the second queued callback, while
// invoke() and the provider still have continuations to run. The original
// backend Promise remains the operation result, including its rejection.
function beforePublication<T>(promise: Promise<T>, cancel: () => void): Promise<T> {
  void promise.then(() => { queueMicrotask(() => { queueMicrotask(cancel) }) }, () => undefined)
  return promise
}

describe('Business Skill publication after backend completion', () => {
  test.each(['list', 'get', 'tool'] as const)('%s rejects disposal between backend completion and publication', async (operation) => {
    const { ctx, service, scope, agent, state } = await setup(10, backend => ({
      ...backend,
      ...(operation === 'list'
        ? { catalog: (...args: Parameters<typeof backend.catalog>) => beforePublication(backend.catalog(...args), () => { terminate() }) }
        : { load: (...args: Parameters<typeof backend.load>) => beforePublication(backend.load(...args), () => { terminate() }) }),
    }))
    let closing: Promise<void> | undefined
    let disposedBeforeResult = false
    const terminate = (): void => { disposedBeforeResult = true; closing = Promise.resolve(scope.dispose()) }
    state.catalog = [entry()]
    try {
      await service.withRequest(request(), async () => {
        const provider = service.attach(agent)!
        if (operation === 'list') {
          await expect(provider.list({})).rejects.toThrow()
        } else if (operation === 'get') {
          const candidate = (await provider.list({}) as SkillProviderObservation).candidates[0]!
          await expect(provider.get(candidate, {})).rejects.toThrow()
        } else {
          const result = await ctx.tools.execute({ name: 'skill', arguments: { name: 'review' }, agent,
            signal: new AbortController().signal, callId: CallId('late-publication') })
          expect(result.isError).toBe(true)
          expect(JSON.stringify(result.content)).not.toContain('<skill_content')
        }
        expect(disposedBeforeResult).toBe(true)
      })
    } finally { await closing; await ctx.fiber.dispose() }
  })

  test.each(['list', 'get'] as const)('%s rejects caller cancellation before publication', async (operation) => {
    const caller = new AbortController()
    const reason = new Error('caller cancelled before publication')
    const { ctx, service, agent, state } = await setup(10, backend => ({
      ...backend,
      ...(operation === 'list'
        ? { catalog: (...args: Parameters<typeof backend.catalog>) =>
          beforePublication(backend.catalog(...args), () => { caller.abort(reason) }) }
        : { load: (...args: Parameters<typeof backend.load>) => beforePublication(backend.load(...args), () => { caller.abort(reason) }) }),
    }))
    state.catalog = [entry()]
    try {
      await service.withRequest(request(), async () => {
        const provider = service.attach(agent)!
        if (operation === 'list') {
          await expect(provider.list({ signal: caller.signal })).rejects.toBe(reason)
        } else {
          const candidate = (await provider.list({}) as SkillProviderObservation).candidates[0]!
          await expect(provider.get(candidate, { signal: caller.signal })).rejects.toBe(reason)
        }
      })
    } finally { await ctx.fiber.dispose() }
  })
})
