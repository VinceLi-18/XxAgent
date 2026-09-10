import { describe, expect, it, vi } from 'vitest'
import { Session, SessionId, SessionPreparation } from '../src/index.ts'

describe('SessionPreparation publication ownership', () => {
  it('commits provider state once and does not release it on disposal', () => {
    const commitPublication = vi.fn()
    const release = vi.fn()
    const preparation = SessionPreparation.create(Session.create(SessionId('commit-preparation')), {
      commitPublication,
      release,
    })

    preparation.commitPublication()
    preparation.commitPublication()
    preparation[Symbol.dispose]()

    expect(commitPublication).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
  })

  it('releases provider state once and rejects a later publication commit', () => {
    const commitPublication = vi.fn()
    const release = vi.fn()
    const preparation = SessionPreparation.create(Session.create(SessionId('release-preparation')), {
      commitPublication,
      release,
    })

    preparation[Symbol.dispose]()
    preparation[Symbol.dispose]()

    expect(release).toHaveBeenCalledOnce()
    expect(() => { preparation.commitPublication() }).toThrow(/cannot commit released session preparation/)
    expect(commitPublication).not.toHaveBeenCalled()
  })

  it('retains rollback ownership when a publication commit throws', () => {
    const release = vi.fn()
    const preparation = SessionPreparation.create(Session.create(SessionId('failed-commit-preparation')), {
      commitPublication: () => { throw new Error('commit failed') },
      release,
    })

    expect(() => { preparation.commitPublication() }).toThrow('commit failed')
    preparation[Symbol.dispose]()

    expect(release).toHaveBeenCalledOnce()
  })

  it('keeps legacy release behavior when no publication commit is configured', () => {
    const release = vi.fn()
    const preparation = SessionPreparation.create(Session.create(SessionId('release-only-preparation')), { release })

    preparation.commitPublication()
    preparation[Symbol.dispose]()

    expect(release).toHaveBeenCalledOnce()
  })
})
