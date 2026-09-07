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
