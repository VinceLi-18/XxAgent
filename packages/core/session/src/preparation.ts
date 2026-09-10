/**
 * Ownership of one unpublished Session before registry publication.
 * @module @deepseek-ai/dsh-session/preparation
 */

import type { Session } from './index.ts'

/** Options for a preparation whose provider retains state through Agent publication. */
export interface SessionPreparationOptions {
  /** Commit provider-owned state after the complete Agent publication succeeds. */
  readonly commitPublication?: () => void
  /** Release provider-owned state when the Session was not published. */
  readonly release?: () => void
}

/**
 * One exact unpublished Session and the provider state that keeps it usable.
 * The Agent publication owner commits retained state only after Session and
 * Agent announcements plus session start succeed. Disposal is synchronous and
 * idempotent; every earlier failure releases the retained state instead.
 */
export class SessionPreparation implements Disposable {
  private committed = false
  private released = false

  /** The exact Session to use for setup and publication. */
  readonly session: Session

  private constructor(
    session: Session,
    private readonly options: SessionPreparationOptions,
  ) {
    this.session = session
  }

  /**
   * Wrap an unpublished Session in one preparation lifetime.
   * @param session - exact unpublished Session.
   * @param options - optional provider release behavior.
   * @returns a preparation disposed after publication or rollback.
   */
  static create(session: Session, options?: SessionPreparationOptions): SessionPreparation {
    return new SessionPreparation(session, options ?? {})
  }

  /** Commit provider-owned state after the complete Agent publication succeeds. */
  commitPublication(): void {
    if (this.committed) return
    if (this.released) throw new Error(`cannot commit released session preparation "${this.session.id}"`)
    const commit = this.options.commitPublication
    if (commit === undefined) return
    commit()
    this.committed = true
  }

  /** Release provider state once when this preparation leaves its caller. */
  [Symbol.dispose](): void {
    if (this.released || this.committed) return
    this.released = true
    this.options.release?.()
  }
}
