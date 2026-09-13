/** Browser-owned Slot and generated Remote relationships for diagnostics. */
export interface BusinessSkillUiRelationships { issue(): string | undefined }
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Live Business Skill panel and Remote ownership. */
    xagentBusinessSkillUiRelationships: BusinessSkillUiRelationships
  }
}
