// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { XAgentCitationController } from '../src/client/service.ts'

const target = {
  artifactId: 'artifact-1', versionId: 'version-1', chunkId: 'chunk-1', lineStart: 7, lineEnd: 9,
}

describe('XAgent citation controller', () => {
  it('sends only the current Session id and citation id, then hands off immutable identity', async () => {
    const remote = { resolve: vi.fn(async () => ({ ok: true as const, value: target })) }
    const artifact = { openCitation: vi.fn(async () => {}) }
    const controller = new XAgentCitationController(remote, artifact, vi.fn())
    controller.setScope('account-a', 'session-701')
    await controller.open('session-701', '[资料1]')
    expect(remote.resolve).toHaveBeenCalledWith('session-701', '[资料1]', expect.any(AbortSignal))
    expect(artifact.openCitation).toHaveBeenCalledWith({
      artifactId: 'artifact-1', versionId: 'version-1', lineStart: 7, lineEnd: 9,
    })
  })

  it('aborts replacement, account and Session changes, failures, cancellation, and disposal', async () => {
    const requests: Array<ReturnType<typeof Promise.withResolvers<never>>> = []
    const signals: AbortSignal[] = []
    const remote = { resolve: vi.fn((_session: string, _citation: string, signal?: AbortSignal) => {
      signals.push(signal!); const request = Promise.withResolvers<never>(); requests.push(request); return request.promise
    }) }
    const artifact = { openCitation: vi.fn(async () => {}) }
    const controller = new XAgentCitationController(remote, artifact, vi.fn())
    controller.setScope('account-a', 'session-701')
    const first = controller.open('session-701', '[资料1]')
    const second = controller.open('session-701', '[资料2]')
    expect(signals[0]?.aborted).toBe(true)
    controller.setScope('account-b', 'session-702')
    expect(signals[1]?.aborted).toBe(true)
    await controller.open('session-701', '[资料1]')
    expect(remote.resolve).toHaveBeenCalledTimes(2)
    controller.setScope('account-b', 'session-702')
    const third = controller.open('session-702', '[资料3]')
    controller.cancel('session-702')
    expect(signals[2]?.aborted).toBe(true)
    const disposing = controller.dispose()
    requests.forEach((request) => { request.reject(new DOMException('aborted', 'AbortError')) })
    await Promise.all([first, second, third, disposing])
    expect(artifact.openCitation).not.toHaveBeenCalled()
  })

  it('keeps Remote failures closed and never opens Artifact state', async () => {
    const remote = { resolve: vi.fn(async () => ({
      ok: false as const, error: { code: 'citation-invalid', message: 'secret', details: {} },
    })) }
    const artifact = { openCitation: vi.fn(async () => {}) }
    const controller = new XAgentCitationController(remote, artifact, vi.fn())
    controller.setScope('account-a', 'session-701')
    await controller.open('session-701', '[资料1]')
    expect(artifact.openCitation).not.toHaveBeenCalled()
  })

  it('cancels Artifact publication when the owning ToolView unmounts during handoff', async () => {
    const handoff = Promise.withResolvers<undefined>()
    const remote = { resolve: vi.fn(async () => ({ ok: true as const, value: target })) }
    const artifact = { openCitation: vi.fn(() => handoff.promise) }
    const cancelArtifactCitation = vi.fn()
    const controller = new XAgentCitationController(remote, artifact, cancelArtifactCitation)
    controller.setScope('account-a', 'session-701')
    const opening = controller.open('session-701', '[资料1]')
    await vi.waitFor(() => { expect(artifact.openCitation).toHaveBeenCalledOnce() })

    controller.cancel('session-701')
    expect(cancelArtifactCitation).toHaveBeenCalledOnce()
    handoff.resolve(undefined)
    await opening
  })

  it('ignores a sibling ToolView cancellation and waits for an active task during disposal', async () => {
    const request = Promise.withResolvers<never>()
    const remote = {
      resolve: vi.fn((_sessionId: string, _citationId: string, _signal?: AbortSignal) => request.promise),
    }
    const artifact = { openCitation: vi.fn(async () => {}) }
    const controller = new XAgentCitationController(remote, artifact, vi.fn())
    controller.setScope('account-a', 'session-701')
    const opening = controller.open('session-701', '[资料1]')
    controller.cancel('session-702')
    expect(remote.resolve.mock.calls[0]![2]!.aborted).toBe(false)
    const disposal = controller.dispose()
    expect(remote.resolve.mock.calls[0]![2]!.aborted).toBe(true)
    request.reject(new DOMException('aborted', 'AbortError'))
    await Promise.all([opening, disposal])
  })
})
