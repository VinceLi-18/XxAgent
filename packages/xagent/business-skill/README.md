# @xagent/dsh-business-skill

English | [中文](README.zh.md)

Authenticated project Business Skills backed by FastAPI governance. The abstract `XAgentBusinessSkillService` defines request lifetime, Agent registration, exact loaded-definition ownership and public governance operations. `FastApiBusinessSkillService` implements these operations with the strict backend client and contributes an Agent-scoped `xagent-project` provider to the [Skill registry](../../skill/skill/README.md).

## Configuration

The Host plugin requires `agents`, `skills`, `tools` and `systemPrompt`. Configure `backendOrigin` as the FastAPI origin, `serviceToken` as the internal Host credential, and `maxCatalogEntries` as a positive safe integer bounding the complete catalog. Missing or invalid configuration fails at installation; oversized backend catalogs fail closed rather than truncating authorized results.

## Request and provider lifetime

The Host authorizer invokes `withRequest` with an authenticated `conversation` Project Session and live physical request and connection signals. Private, test-purpose, malformed, cancelled, nested and disposed requests are rejected. Browser methods accept only public Skill names, version/run numbers, mutation fields and pagination; the user token, project and Session come exclusively from the authenticated request.

The Consumer captures each inbox message's physical request when inserted and attaches its provider when that message is claimed, only for the exact Agent whose Session matches the request. An unowned or mixed-request claim closes bound execution for that turn. `attach` also supports explicit Host discovery; it cannot activate a Skill without an owned claim. Registration is idempotent for the same Agent and request; another request or duplicate provider cannot replace its owner. Request settlement, cancellation, Agent disposal and service disposal remove registrations. Provider and caller cancellation reach the backend transport together. Teardown closes authorization immediately, retains execution protection until admitted calls settle, and discards late responses even when the transport ignores cancellation.

Each registry lookup obtains an independent authoritative non-cacheable catalog, sorted by public slug. Duplicate slugs and malformed responses fail closed. The slug is the model-visible skill name; display names remain governance fields. Provider-owned locators identify exact candidates from their own observations and cannot be copied or transferred between Agents or physical requests. Concurrent discovery and refresh do not invalidate an in-flight observation. Every load reauthorizes the exact Session, project, slug and immutable version through FastAPI; a backend version-change conflict retains the public `business-skill-version-changed` code. The loaded identity and description must match its observation, and repeated loads cannot change the contents of the same retained version.

Both the model `skill` tool and explicit `/slug` gestures use the existing loader and renderer. Definitions contain only public metadata and instructions. After its final await, the provider checks caller cancellation and exact live registration again before publishing candidates or instructions; publication safety does not depend on the optional invariant companion. `loadedVersion` recovers Host-private version data by exact definition and Agent identity while the request registration is live; copied definitions, stale requests and other Agents have no ownership. The invariant companion checks actual `skill/loaded` admissions against this relationship.

## Turn binding and tools

The awaited `skill/loaded` event admits one immutable Business Skill per turn. Same-Skill reloads reauthorize `skill` against that pinned version and reuse its exact body; a second Skill fails with `business-skill-conflict` without changing the first pin or closing its declared tools. Publication and rollback change later turns only. A load fails if the complete tool set or SHA-256 policy digest differs from the version-1 resolver, a required tool is unavailable, or the `search_artifacts` / `submit_cited_answer` companion relation is asymmetric. The closed production set comprises `skill`, `list_accessible_projects`, `search_artifacts`, `submit_cited_answer` and `propose_fact`; the backend selects the exact subset. Project discovery does not broaden ordinary Project or Private conversations.

The only deferred registration is `submit_cited_answer`: the complete policy must include both retrieval tools, and the Agent must resolve the real retrieval service and a live `search_artifacts` definition owned by its tool Consumer. The companion becomes visible after durable search evidence registers it; every execution still requires fresh authorization. A same-name or copied search definition cannot enable this exception.

Activation restricts inherited tools and filters every Agent-local schema from prompt assembly against the complete set. Explicit `/slug` activation also narrows that step's already assembled array before its first request header is logged. Each bound execution awaits fresh backend authorization with its pinned version and physical request; a final guard requires authorization for that exact call. Denial, cancellation, backend failure and invalid responses never execute the tool body, and a failed bound-tool call closes subsequent execution for the turn. The stable denial is `Business Skill tool execution is unavailable for this turn.`

The ignorable `business-skill/activated` event records only slug, public version, invocation form, turn and policy digest. The ordinary tool result or `skill-invocation` message preserves the exact original body. A durable `turn/end` permits replacing those admitted messages with `Business Skill <slug> v<version> was used in turn <turn>.`; provisional Stop steering retains the pin, body and tools. Idle notification, the next assembly or claim, and Session startup project completed admissions, including repaired crash tails. Later model history contains the marker while original append records retain the instructions. Request teardown closes the pin and restrictions but never projects an unfinished turn. Active authorization and dispatch callbacks own their settlement independently of unloadable result listeners.

An Agent-scoped approval listener delegates to the normal answerer chain and races that answer against physical-request cancellation. Cancellation returns `cancelled` without waiting for an unresponsive answerer; late answers and rejections cannot execute the tool or alter the recorded decision.

## Governance and testing

The `xagentBusinessSkill` Remote provides list, detail, create, draft, test, transcript, verdict, publish, authorization, version and retire operations. Backend authorization and lifecycle decisions remain authoritative. Known backend errors retain their stable codes; unknown failures become `service-unavailable` with no internal details. Caller cancellation is combined with request, connection and service cancellation, and responses are checked again after completion.

`registerTestRunner` contributes one reversible Host-only executor. The test Remote rejects before starting backend work unless an executor is installed. That executor owns isolated Session admission, execution and settlement and returns only a public test record. A test transcript is separately paginated by public run number.

## Model Experience

Indirectly, through `dsh-tool-skill`, the model receives authorized instructions and a narrowed tool catalog with fresh execution authorization.

#### KV Cache effect

Public catalog replacements and immutable Skill bodies consume tokens through the generic loader. Turn-ending replacement changes the historical request prefix to the short use marker. Internal locators, version handles, account credentials and authorization data never enter model context.

## Known Limitations and Deferred Work

- The dedicated read-only test executor and Business profile composition are separate integrations; this package alone does not expose governance in other profiles or execute a test scenario.
- Backend reads add authorization latency and have no offline fallback.
