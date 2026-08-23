/** Durable settings namespace for product-wide GUI onboarding facts. */
export const WELCOME_NOTICE_SETTINGS_NAMESPACE = 'ui-onboarding'

/** Field storing the last welcome notice version the user acknowledged. */
export const WELCOME_NOTICE_ACK_FIELD = 'welcomeNoticeVersion'

/**
 * Bump only when the notice changes materially and every user should see it
 * again. The acknowledgement is compared for exact equality.
 */
export const WELCOME_NOTICE_VERSION = '2026-08-22.1'

/** The complete XAgent welcome notice in both supported GUI locales. */
export const WELCOME_NOTICE_COPY = {
  zh: {
    title: 'XAgent',
    body: 'XAgent 用于组织项目上下文、资料与协作任务。配置模型后即可开始新会话。',
    continueLabel: '继续',
  },
  en: {
    title: 'XAgent',
    body: 'XAgent organizes project context, resources, and collaborative tasks. Configure a model to start a new session.',
    continueLabel: 'Continue',
  },
} as const
