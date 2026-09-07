import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const THEME_STYLES = new URL('../../../client/ui-theme/src/styles/', import.meta.url)
const CITATION_STYLES = new URL('../src/client/citation.module.css', import.meta.url)

describe('citation ToolView styles', () => {
  it('uses declared design tokens with wrapping, visible focus, and reduced-motion handling', () => {
    const styles = readFileSync(CITATION_STYLES, 'utf8')
    const theme = readdirSync(THEME_STYLES).filter(name => name.endsWith('.css'))
      .map(name => readFileSync(new URL(name, THEME_STYLES), 'utf8')).join('\n')
    const declared = new Set([...theme.matchAll(/^\s*(--dsw-[\w-]+)\s*:/gm)].map(match => match[1]!))
    const referenced = new Set([...styles.matchAll(/var\((--dsw-[\w-]+)/g)].map(match => match[1]!))
    expect([...referenced].filter(token => !declared.has(token))).toEqual([])
    expect(styles).toContain('flex-wrap: wrap')
    expect(styles).toContain(':focus-visible')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
