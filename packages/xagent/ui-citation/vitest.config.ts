import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['../../../tsconfig.base.json'] })],
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    setupFiles: ['../../../scripts/test-invariants.ts'],
  },
})
