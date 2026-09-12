# XAgent runtime packages

English | [中文](README.zh.md)

This group contains the Host security boundaries and browser product surfaces for the multi-user XAgent runtime. Its private `@xagent` package scope is not part of upstream dsh's default composition.

| Package | Responsibility |
| --- | --- |
| `@xagent/dsh-principal` | Strictly parse FastAPI introspection results and bind Host-generated connection identities |
| `@xagent/dsh-backend-client` | Access fixed FastAPI internal paths with service identity and the user's JWT |
| `@xagent/dsh-delegation-token` | Issue and verify scope-limited, single-use Ed25519 delegations lasting at most 60 seconds |
| `@xagent/dsh-connection-auth` | Bind the browser Cookie login to the Principal for each Connection request and physical WebSocket |
| `@xagent/dsh-authorization` | Resolve read or edit authorization through FastAPI and RLS before Session RPC execution |
| `@xagent/dsh-session-persistence-api` | Use FastAPI/PostgreSQL as the only Business Session Header and event authority |
| `@xagent/dsh-project` | Proxy the project workbench within the Principal request scope bound to a physical connection |
| `@xagent/dsh-artifact` | Proxy artifact operations in that scope and stream short-lived signed content through fixed same-origin routes |
| `@xagent/dsh-retrieval` | Issue per-call delegations in the authenticated prompt scope, call hybrid retrieval, and own opaque receipt lifetimes |
| `@xagent/dsh-tool-retrieval` | Provide explicitly scoped project discovery and read-only artifact retrieval model tools |
| `@xagent/dsh-fact` | Provide governed Project Fact proposals, approval Remotes, private receipt/Outbox sidecars, and one-use later-turn decision projection |
| `@xagent/dsh-tool-fact` | Provide the Native `propose_fact` tool only for authenticated Project requests |
| `@xagent/dsh-business-skill` | Bind governed project Skill discovery, immutable version activation, per-call tool authorization, and isolated draft tests to the authenticated request |
| `@xagent/dsh-ui-account` | Provide the production login, account-state, and logout surface |
| `@xagent/dsh-ui-project` | Provide project navigation, context identity, and the third-column project overview |
| `@xagent/dsh-ui-artifact` | Provide artifact upload, scan status, immutable versions, preview, and download in the project details Slot |
| `@xagent/dsh-ui-citation` | Render structured cited answers and navigate verified evidence to the exact immutable version |
| `@xagent/dsh-ui-fact` | Provide current Facts, pending proposals, immutable history, and role-gated decisions in project details |
| `@xagent/dsh-ui-business-skill` | Provide the role-gated Draft → Test → Publish → Authorize workflow and version, test, and audit history |

These packages do not take over a generic dsh Profile. They become active only when the XAgent Business bundle explicitly mounts them; Developer and upstream Profiles receive neither these services nor their service credential or delegation private key. Artifact management remains a human-interface capability. The separately mounted retrieval tools add only currently authorized read-only evidence to the Session and model context. Fact writes register only in authenticated Project requests; asynchronous human decisions enter the source Session through its Outbox without starting a turn and appear once, in log order, on the next user-initiated model request. Business Skills are governed project content: read-only tests exclude production Fact writes, published invocation uses one immutable version per turn, and each tool call reauthorizes through FastAPI.
