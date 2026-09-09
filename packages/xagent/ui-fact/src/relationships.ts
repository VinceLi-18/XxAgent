/** Live browser assembly relationship exposed to invariant diagnostics. */
export interface XAgentFactUiRelationships {
  issue(): string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Live Fact Slot, ToolView, and controller relationship. */
    xagentFactUiRelationships: XAgentFactUiRelationships
  }
}
