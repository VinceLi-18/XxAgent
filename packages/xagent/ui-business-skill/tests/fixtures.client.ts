import type { XAgentBusinessSkillDetail } from '@xagent/dsh-backend-client/types'
import { vi } from 'vitest'
import type { BusinessSkillRemote } from '../src/client/service.ts'

export const detail: XAgentBusinessSkillDetail = {
  slug: 'review-facts', displayName: '审核项目事实', status: 'active', authorized: false,
  draftRevision: 2, updatedAt: '2026-09-12',
  draft: { revision: 2, description: '审核事实', instructions: '# 审核', primaryTools: ['search_artifacts', 'propose_fact'], contentDigest: 'content', toolPolicyDigest: 'policy' },
  versions: [], tests: [{ runNumber: 3, draftRevision: 2, contentDigest: 'content', toolPolicyDigest: 'policy', unexecutedWriteTools: ['propose_fact'], status: 'completed', terminationReason: 'completed', verdict: 'pass', startedAt: '2026-09-12' }], auditSummary: [],
}
export const scope = { accountId: 'account', projectId: 'project', sessionId: 'session', role: 'manager' as const, generation: {} }
export const ok = <T>(value: T) => ({ ok: true as const, value })
export function remoteFixture() {
  return { list: vi.fn<BusinessSkillRemote['list']>(async () => ok({ items: [detail] })), detail: vi.fn<BusinessSkillRemote['detail']>(async () => ok(detail)), create: vi.fn<BusinessSkillRemote['create']>(async () => ok(detail)), draft: vi.fn<BusinessSkillRemote['draft']>(async () => ok(detail)), test: vi.fn<BusinessSkillRemote['test']>(async () => ok(detail.tests[0]!)), transcript: vi.fn<BusinessSkillRemote['transcript']>(async () => ok({ test: detail.tests[0]!, events: [], nextSequence: 0 })), verdict: vi.fn<BusinessSkillRemote['verdict']>(async () => ok(detail)), publish: vi.fn<BusinessSkillRemote['publish']>(async () => ok(detail)), authorization: vi.fn<BusinessSkillRemote['authorization']>(async () => ok(detail)), version: vi.fn<BusinessSkillRemote['version']>(async () => ok(detail)), retire: vi.fn<BusinessSkillRemote['retire']>(async () => ok(detail)) }
}
