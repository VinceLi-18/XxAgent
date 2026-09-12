import { defineConfig } from 'tsdown'

/** The companion must read the provider's identity registry from the same package instance. */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
  deps: { neverBundle: ['@xagent/dsh-business-skill'] },
})
