/** Project-scoped governed Fact proposal tool. @module @xagent/dsh-tool-fact */

import { symbols, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, ToolArgsError, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { XAgentFactError, type XAgentFactServiceContract } from '@xagent/dsh-fact'
import {
  currentXAgentAuthenticatedRequestScope,
  isXAgentAuthenticatedRequestScope,
  type XAgentAuthenticatedSessionRequestScope,
} from '@xagent/dsh-principal'

/** Cordis plugin name. */
export const name = 'xagent-tool-fact'
/** Services required by the scoped tool Consumer. */
export const inject = ['agents', 'tools']

interface MessageBinding {
  readonly agent: Agent
  readonly scope?: ProjectScope
  readonly close?: () => void
}

interface ToolRegistration {
  readonly scope: ProjectScope
  readonly definition: ToolDefinition
  readonly dispose: () => unknown
  readonly closeSignals: () => void
}

interface FactToolRelationship {
  readonly registrations: Map<Agent, ToolRegistration>
}

type ProjectScope = XAgentAuthenticatedSessionRequestScope & {
  readonly visibility: 'project'
  readonly projectId: string
  readonly requestSignal: AbortSignal
  readonly connectionSignal: AbortSignal
}

const relationships = new WeakMap<object, Set<FactToolRelationship>>()

/** Stable service identity shared by scoped Cordis proxy views. */
function relationshipKey(ctx: Context): object {
  const runtime = ctx.tools as Context['tools'] & { [symbols.original]?: object }
  return runtime[symbols.original] ?? runtime
}

const FIELD_KEY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u
const CITATION_ID = /^\[资料([1-9][0-9]*)\]$/u
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const MAX_FIELD_KEY_BYTES = 128
const MAX_LABEL_BYTES = 255
const MAX_TEXT_BYTES = 16 * 1024
const MAX_REASON_BYTES = 4 * 1024

const FACT_VALUE = {
  oneOf: [
    {
      type: 'object' as const,
      additionalProperties: false,
      description: 'A text Fact value.',
      properties: {
        type: { type: 'string' as const, const: 'text', required: true, description: 'Use text for a text value.' },
        value: { type: 'string' as const, required: true, description: 'Text value, at most 16 KiB in UTF-8.' },
      },
    },
    {
      type: 'object' as const,
      additionalProperties: false,
      description: 'A finite numeric Fact value.',
      properties: {
        type: { type: 'string' as const, const: 'number', required: true, description: 'Use number for a numeric value.' },
        value: { type: 'number' as const, required: true, description: 'Finite number; integral values must be safe integers.' },
      },
    },
    {
      type: 'object' as const,
      additionalProperties: false,
      description: 'A boolean Fact value.',
      properties: {
        type: { type: 'string' as const, const: 'boolean', required: true, description: 'Use boolean for a true or false value.' },
        value: { type: 'boolean' as const, required: true, description: 'Boolean value.' },
      },
    },
    {
      type: 'object' as const,
      additionalProperties: false,
      description: 'A calendar-date Fact value.',
      properties: {
        type: { type: 'string' as const, const: 'date', required: true, description: 'Use date for a calendar date.' },
        value: {
          type: 'string' as const,
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          required: true,
          description: 'Valid Gregorian calendar date in YYYY-MM-DD form.',
        },
      },
    },
  ],
  description: 'Typed value proposed for the project Fact.',
} as const

const PARAMETERS = {
  field_key: {
    type: 'string' as const,
    required: true,
    description: 'Stable lowercase field key using letters, digits, dots, underscores, or hyphens; at most 128 UTF-8 bytes.',
  },
  label: {
    type: 'string' as const,
    required: true,
    description: 'Non-empty human-readable Fact label, at most 255 UTF-8 bytes.',
  },
  value: { ...FACT_VALUE, required: true },
  evidence_ids: {
    type: 'array' as const,
    maxItems: 64,
    uniqueItems: true,
    items: { type: 'string' as const, description: 'Admitted citation ID in [资料N] form.' },
    description: 'Up to 64 distinct citation IDs already admitted to this Session.',
  },
  assertion_reason: {
    type: 'string' as const,
    description: 'Non-blank assertion basis, at most 4 KiB in UTF-8; required when evidence_ids is empty or omitted.',
  },
} as const

const OUTPUT = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    proposalId: { type: 'string' as const, required: true, description: 'Server proposal UUID.' },
    status: { type: 'string' as const, const: 'pending', required: true, description: 'Initial proposal review status.' },
  },
} as const

/** Throw one stable model-correctable argument failure. */
function invalid(message: string): never {
  throw new ToolArgsError([message])
}

/** Require a non-empty string no larger than one UTF-8 byte ceiling. */
function boundedUtf8(value: string, maximum: number, path: string, allowEmpty = false): void {
  if ((!allowEmpty && value.length === 0) || new TextEncoder().encode(value).byteLength > maximum) {
    invalid(`"${path}" must be ${allowEmpty ? '' : 'non-empty and '}at most ${maximum} UTF-8 bytes`)
  }
}

/** Validate Gregorian date semantics beyond the public lexical pattern. */
function validateDate(value: string): void {
  const match = DATE.exec(value) as RegExpExecArray
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const maximumDay = monthDays[month - 1]
  if (year < 1 || month < 1 || month > 12 || day < 1 || maximumDay === undefined || day > maximumDay) {
    invalid('"value.value" must be a valid YYYY-MM-DD calendar date')
  }
}

/** Enforce backend-aligned semantic and UTF-8 limits at the model boundary. */
function validateProposal(args: {
  readonly field_key: string
  readonly label: string
  readonly value:
    | { readonly type: 'text'; readonly value: string }
    | { readonly type: 'number'; readonly value: number }
    | { readonly type: 'boolean'; readonly value: boolean }
    | { readonly type: 'date'; readonly value: string }
  readonly evidence_ids?: readonly string[]
  readonly assertion_reason?: string
}): void {
  boundedUtf8(args.field_key, MAX_FIELD_KEY_BYTES, 'field_key')
  if (!FIELD_KEY.test(args.field_key)) invalid('"field_key" must use the supported lowercase field-key format')
  boundedUtf8(args.label, MAX_LABEL_BYTES, 'label')
  if (args.value.type === 'text') boundedUtf8(args.value.value, MAX_TEXT_BYTES, 'value.value', true)
  if (args.value.type === 'number' && Number.isInteger(args.value.value) && !Number.isSafeInteger(args.value.value)) {
    invalid('"value.value" integral numbers must be safe integers')
  }
  if (args.value.type === 'date') validateDate(args.value.value)
  for (const evidenceId of args.evidence_ids ?? []) {
    const ordinal = CITATION_ID.exec(evidenceId)?.[1]
    if (ordinal === undefined || !Number.isSafeInteger(Number(ordinal))) {
      invalid('"evidence_ids" entries must be admitted citation IDs such as [资料1]')
    }
  }
  if (args.assertion_reason !== undefined) {
    boundedUtf8(args.assertion_reason, MAX_REASON_BYTES, 'assertion_reason')
    if (args.assertion_reason.trim().length === 0) invalid('"assertion_reason" must be non-blank')
  }
  if ((args.evidence_ids?.length ?? 0) === 0 && args.assertion_reason === undefined) {
    invalid('"assertion_reason" is required when evidence_ids is empty or omitted')
  }
}

function sessionId(agent: Agent): string | undefined {
  return /^session-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/u.exec(String(agent.session.id))?.[1]
}

function currentProjectScope(agent: Agent): ProjectScope | undefined {
  const scope = currentXAgentAuthenticatedRequestScope()
  if (scope === undefined || !isXAgentAuthenticatedRequestScope(scope) || !('sessionId' in scope)) return undefined
  const sessionScope = scope as XAgentAuthenticatedSessionRequestScope
  return sessionScope.visibility === 'project'
    && typeof sessionScope.projectId === 'string'
    && UUID.test(sessionScope.projectId)
    && sessionScope.sessionId === sessionId(agent)
    && sessionScope.requestSignal instanceof AbortSignal
    && sessionScope.connectionSignal instanceof AbortSignal
    && !sessionScope.requestSignal.aborted
    && !sessionScope.connectionSignal.aborted
    ? sessionScope as ProjectScope
    : undefined
}

function sameScope(left: XAgentAuthenticatedSessionRequestScope, right: XAgentAuthenticatedSessionRequestScope): boolean {
  return left.sessionId === right.sessionId
    && left.projectId === right.projectId
    && left.connectionId === right.connectionId
    && left.userToken === right.userToken
    && left.principal.actorId === right.principal.actorId
    && left.principal.authSessionId === right.principal.authSessionId
    && left.principal.permissionRevision === right.principal.permissionRevision
    && left.requestSignal === right.requestSignal
    && left.connectionSignal === right.connectionSignal
}

/**
 * Inspect active scoped registration relationships for runtime diagnostics.
 * @param ctx - context carrying the authoritative tool registry and optional Fact service.
 * @returns The first mutable ownership inconsistency, or `undefined`.
 */
export function xAgentFactToolRelationshipIssue(ctx: Context): string | undefined {
  if (ctx.tools.get('propose_fact') !== undefined) return 'propose_fact must not be registered globally'
  for (const relationship of relationships.get(relationshipKey(ctx)) ?? []) {
    if (ctx.get('xagentFact') === undefined) return 'a scoped propose_fact registration requires the Fact service'
    for (const [agent, registration] of relationship.registrations) {
      if (agent.ctx.tools.get('propose_fact', agent) !== registration.definition) {
        return 'the tracked propose_fact registration must match the Agent-scoped tool registry'
      }
      if (registration.scope.requestSignal.aborted || registration.scope.connectionSignal.aborted) {
        return 'an aborted physical scope must not retain propose_fact'
      }
    }
  }
  return undefined
}

/** Build one scoped definition bound to the active Fact service instance. */
function proposeFactDefinition(fact: XAgentFactServiceContract): ToolDefinition {
  const definition = defineTool({
    name: 'propose_fact',
    nativeOnly: true,
    description: 'Propose a project Fact for manager review.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({
        kind: 'xagent-fact',
        status: 'pending',
        proposalId: value.proposalId,
      }),
    },
    async execute(args, exec) {
      validateProposal(args)
      if (exec.agent === undefined || sessionId(exec.agent) === undefined) {
        throw new XAgentFactError('fact-session-invalid')
      }
      return fact.proposeFact({
        sessionId: String(exec.agent.session.id),
        toolCallId: String(exec.callId),
        fieldKey: args.field_key,
        label: args.label,
        value: args.value,
        evidenceIds: args.evidence_ids ?? [],
        ...args.assertion_reason === undefined ? {} : { assertionReason: args.assertion_reason },
        signal: exec.signal,
      })
    },
  })
  definition.parameters.additionalProperties = false
  return definition
}

/** Install the Project-scoped Fact proposal Consumer. */
export function apply(ctx: Context): void {
  ctx.inject(['xagentFact'], (factCtx) => {
    const messages = new Map<string, MessageBinding>()
    const registrations = new Map<Agent, ToolRegistration>()
    const definition = proposeFactDefinition(factCtx.xagentFact)
    const relationship = { registrations }
    const key = relationshipKey(ctx)
    const toolRelationships = relationships.get(key) ?? new Set<FactToolRelationship>()
    toolRelationships.add(relationship)
    relationships.set(key, toolRelationships)

    const deleteMessage = (messageId: string): void => {
      const binding = messages.get(messageId)
      messages.delete(messageId)
      binding?.close?.()
    }
    const deleteAgentMessages = (agent: Agent): void => {
      for (const [messageId, binding] of messages) {
        if (binding.agent === agent) deleteMessage(messageId)
      }
    }

    const unregister = (agent: Agent): void => {
      const registration = registrations.get(agent)
      if (registration === undefined) return
      registrations.delete(agent)
      registration.closeSignals()
      registration.dispose()
    }
    const register = (agent: Agent, scope: ProjectScope): void => {
      const current = registrations.get(agent)
      if (current !== undefined && sameScope(current.scope, scope)) return
      unregister(agent)
      const abort = (): void => { unregister(agent) }
      scope.requestSignal.addEventListener('abort', abort, { once: true })
      scope.connectionSignal.addEventListener('abort', abort, { once: true })
      const dispose = agent.ctx.tools.register(definition)
      registrations.set(agent, {
        scope,
        definition,
        dispose,
        closeSignals: () => {
          scope.requestSignal.removeEventListener('abort', abort)
          scope.connectionSignal.removeEventListener('abort', abort)
        },
      })
    }

    factCtx.on('agent/inbox/inserted', ({ agent, message }) => {
      const scope = currentProjectScope(agent)
      const messageId = String(message.id)
      deleteMessage(messageId)
      if (scope === undefined) {
        messages.set(messageId, { agent })
      } else {
        const invalidate = (): void => { deleteMessage(messageId) }
        scope.requestSignal.addEventListener('abort', invalidate, { once: true })
        scope.connectionSignal.addEventListener('abort', invalidate, { once: true })
        messages.set(messageId, {
          agent,
          scope,
          close: () => {
            scope.requestSignal.removeEventListener('abort', invalidate)
            scope.connectionSignal.removeEventListener('abort', invalidate)
          },
        })
      }
      const active = registrations.get(agent)
      if (active !== undefined && (scope === undefined || !sameScope(active.scope, scope))) unregister(agent)
    })
    factCtx.on('agent/inbox/discarded', ({ message }) => {
      deleteMessage(String(message.id))
    })
    factCtx.on('agent/pre-step', async ({ agent, messages: claimed }, next) => {
      if (claimed.length > 0) {
        const scopes = claimed.map((message) => {
          const binding = messages.get(String(message.id))
          deleteMessage(String(message.id))
          const scope = binding?.agent === agent ? binding.scope : undefined
          return scope !== undefined
            && !scope.requestSignal.aborted
            && !scope.connectionSignal.aborted
            ? scope
            : undefined
        })
        const scope = scopes[0]
        if (scope !== undefined && scopes.every(value => value !== undefined && sameScope(value, scope))) {
          register(agent, scope)
        } else {
          unregister(agent)
        }
      }
      const decision = await next()
      if (decision.kind === 'reject') unregister(agent)
      return decision
    })
    factCtx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      for (const agent of registrations.keys()) {
        if (agent.session === session) unregister(agent)
      }
    })
    factCtx.on('agent/error', ({ agent }) => {
      deleteAgentMessages(agent)
      unregister(agent)
    })
    factCtx.on('agent/disposed', ({ agent }) => {
      deleteAgentMessages(agent)
      unregister(agent)
    })
    factCtx.effect(() => () => {
      for (const messageId of [...messages.keys()]) deleteMessage(messageId)
      for (const agent of [...registrations.keys()]) unregister(agent)
      toolRelationships.delete(relationship)
      /* v8 ignore else -- one Fact-service injection owns the relationship until its fiber disposes. */
      if (toolRelationships.size === 0) relationships.delete(key)
    }, 'xagent Fact tool scopes')
  })
}
