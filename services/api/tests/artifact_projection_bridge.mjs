/** Exercise the built Host Artifact client against a real API process. */
import { XAgentBackendClient, XAgentBackendError } from '../../../packages/xagent/backend-client/lib/index.js'

let input = ''
for await (const chunk of process.stdin) input += chunk
const { origin, token, serviceToken, method, args } = JSON.parse(input)
const backend = new XAgentBackendClient({ origin, serviceToken })
try {
  const value = await backend.artifacts[method](token, ...args)
  process.stdout.write(JSON.stringify({ ok: true, value }))
} catch (error) {
  if (!(error instanceof XAgentBackendError)) throw error
  process.stdout.write(JSON.stringify({ ok: false, code: error.code }))
}
