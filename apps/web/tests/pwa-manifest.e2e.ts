import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
  expect(index).toContain('<title>XAgent</title>')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toMatchObject({
    id: '/',
    name: 'XAgent',
    short_name: 'XAgent',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [{
      src: '/favicon.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any',
    }],
  })
})

it('ships a currentColor X mark that switches to a light mark under dark color scheme', async () => {
  const favicon = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  // The mark's fill inherits the SVG color; the media query is the only
  // selector that swaps its ink for the dark product surface.
  expect(favicon).toContain('fill="currentColor"')
  expect(favicon).toContain('color: #14213D')
  expect(favicon).toMatch(/@media \(prefers-color-scheme: dark\)\s*{\s*svg\s*{[^}]*color:\s*#F6F8FB/i)
})
