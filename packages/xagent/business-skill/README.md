# @xagent/dsh-business-skill

English | [中文](README.zh.md)

Authenticated project Business Skills backed by FastAPI governance. The abstract `XAgentBusinessSkillService` defines request lifetime, Agent registration, exact loaded-definition ownership and public governance operations. `FastApiBusinessSkillService` implements these operations with the strict backend client and contributes an Agent-scoped `xagent-project` provider to the [Skill registry](../../skill/skill/README.md).

## Configuration

The Host plugin requires `agents` and `skills`. Configure `backendOrigin` as the FastAPI origin, `serviceToken` as the internal Host credential, and `maxCatalogEntries` as a positive safe integer bounding the complete catalog. Missing or invalid configuration fails at installation; oversized backend catalogs fail closed rather than truncating authorized results.

## Request and provider lifetime

The Host authorizer invokes `withRequest` with an authenticated `conversation` Project Session and live physical request and connection signals. Private, test-purpose, malformed, cancelled, nested and disposed requests are rejected. Browser methods accept only public Skill names, version/run numbers, mutation fields and pagination; the user token, project and Session come exclusively from the authenticated request.

At `agent/pre-step`, the Consumer attaches a provider only to the exact Agent whose Session matches that request. `attach` also supports an explicit Host admission. Registration is idempotent for the same Agent and request; another request or duplicate provider cannot replace its owner. Request settlement, cancellation, Agent disposal and service disposal remove registrations. Provider and caller cancellation reach the backend transport together. Request, Agent and service teardown wait for their in-flight backend operations to settle and discard late responses even when the transport ignores cancellation.

Each registry lookup obtains an independent authoritative non-cacheable catalog, sorted by public slug. Duplicate slugs and malformed responses fail closed. The slug is the model-visible skill name; display names remain governance fields. Provider-owned locators identify exact candidates from their own observations and cannot be copied or transferred between Agents or physical requests. Concurrent discovery and refresh do not invalidate an in-flight observation. Every load reauthorizes the exact Session, project, slug and immutable version through FastAPI; a backend version-change conflict retains the public `business-skill-version-changed` code. The loaded identity and description must match its observation, and repeated loads cannot change the contents of the same retained version.

Both the model `skill` tool and explicit `/slug` gestures use the existing loader and renderer. Definitions contain only public metadata and instructions. `loadedVersion` recovers Host-private version data by exact definition and Agent identity while the request registration is live; copied definitions, stale requests and other Agents have no ownership. The invariant companion checks actual `skill/loaded` admissions against this relationship.

## Governance and testing

The `xagentBusinessSkill` Remote provides list, detail, create, draft, test, transcript, verdict, publish, authorization, version and retire operations. Backend authorization and lifecycle decisions remain authoritative. Known backend errors retain their stable codes; unknown failures become `service-unavailable` with no internal details. Caller cancellation is combined with request, connection and service cancellation, and responses are checked again after completion.

`registerTestRunner` contributes one reversible Host-only executor. The test Remote rejects before starting backend work unless an executor is installed. That executor owns isolated Session admission, execution and settlement and returns only a public test record. A test transcript is separately paginated by public run number.

## Model Experience

Indirectly, through `dsh-tool-skill`, which consumes the authorized catalog and loaded public instructions.

#### KV Cache effect

Public catalog replacements and immutable Skill bodies affect tokens through the generic loader. Internal locators, version handles, account credentials and authorization data never enter model context.

## Known Limitations and Deferred Work

- Production request admission, one-version turn binding, tool authorization and instruction retirement require the Business runtime Consumer. The dedicated read-only test executor and Business profile composition are separate integrations; this package alone does not expose governance in other profiles or execute a test scenario.
- Backend reads add authorization latency and have no offline fallback.
