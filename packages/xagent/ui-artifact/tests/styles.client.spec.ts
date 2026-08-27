import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const THEME_STYLES = new URL('../../../client/ui-theme/src/styles/', import.meta.url)
const ARTIFACT_STYLES = new URL('../src/client/artifact.module.css', import.meta.url)

function themeTokens(): Set<string> {
  const styles = readdirSync(THEME_STYLES)
    .filter(name => name.endsWith('.css'))
    .map(name => readFileSync(new URL(name, THEME_STYLES), 'utf8'))
    .join('\n')
  return new Set([...styles.matchAll(/^\s*(--dsw-[\w-]+)\s*:/gm)].map(match => match[1]!))
}

describe('资料面板样式', () => {
  it('引用的设计系统 token 均由主题声明', () => {
    const styles = readFileSync(ARTIFACT_STYLES, 'utf8')
    const referenced = new Set([...styles.matchAll(/var\((--dsw-[\w-]+)/g)].map(match => match[1]!))
    const declared = themeTokens()
    expect([...referenced].filter(token => !declared.has(token))).toEqual([])
  })
})
