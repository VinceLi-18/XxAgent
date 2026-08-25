# Agent Note: XAgent account-scoped project workbench

Status: implemented

English | [中文](2026-08-25-xagent-project-workbench.zh.md)

## Problem

The XAgent Business profile serves multiple accounts from one Host process. A project workbench therefore cannot derive identity, project visibility, creation authority, or the current working context from browser payloads, profile-local state, or shared in-memory defaults. Account changes and permission grants must also invalidate stale browser state without adding XAgent behavior to the Developer or upstream profiles.

## Decision

FastAPI and PostgreSQL own account capabilities, visible projects, the selected workbench or project context, and the Session scope index. Managers receive `project.create` by role; specialists receive it only through a server-side grant. A permission revision change revokes existing logins, so the browser must authenticate again before receiving the new capability set.

The Host authorizer derives an immutable principal from the authenticated connection and opens an `AsyncLocalStorage` request scope around the four `xagentProject` Remote methods. Those methods read the user token only from that scope. Backend business rejections cross Typert through an explicit `TypertRemoteFailure`; the shared RPC schema recognizes the stable XAgent codes, while unknown exceptions remain `internal`. No identity-like request field is trusted.

Session creation uses the account's server-selected context. Workbench context creates private Sessions; project context creates project Sessions. The existing [authentication and Session isolation decision](2026-08-25-xagent-auth-session-runtime.md) remains authoritative for project-reference registration and fail-closed access when a referenced project becomes invisible.

The browser connection exposes an inert request-header contribution service. The XAgent account plugin is the only contributor: it reads the `xagent_csrf` cookie and adds the matching header to both generated Remote calls and the existing Web API client. Without that plugin, the connection transport behaves as before.

The XAgent project client mounts its generated Remote contribution and publishes one account-scoped workbench controller. The controller treats each server Bootstrap as the only project-state source, keeps no project data in browser storage, and uses an account epoch plus cancellation to discard late responses. It registers the project browser, central context marker, details pane, and operation shield through reversible Slots. The account plugin resets the workbench before exposing another account. Wide layouts show the details pane as the third column; narrow layouts use the layout-owned drawer.

Only `xagent-business` mounts the project Host, account UI, and project UI rows. `xagent-developer`, ordinary Web profiles, and the separate JiaxinAgent repository retain their existing composition and behavior.

## Alternatives considered

**Persist project lists and selected context in localStorage.** Rejected because browser storage is not an authorization source and can briefly expose the previous account's project names after an account switch.

**Send account or role fields in each Remote payload.** Rejected because the browser can forge them; the physical connection's authenticated principal is the only Host identity source.

**Keep CSRF handling inside each XAgent Remote caller.** Rejected because Session and generated Remote transports would diverge. The inert contribution service gives both transports one lifecycle-bound mechanism without changing profiles that mount no contributor.

**Add project UI directly to the generic layout or sidebar.** Rejected because it would couple upstream DSH profiles to XAgent product semantics. Slots keep the generic shell unchanged when the XAgent registrants are absent.

## Consequences

Account switching, project visibility, project creation, and Session scope are all server-authoritative. A stale permission revision forces reauthentication, and late responses cannot restore the prior account. Stable business errors remain machine-readable without exposing FastAPI response bodies or credentials.

The Business profile now depends on FastAPI for its first authenticated workbench Bootstrap and for every context change. When that service is unavailable, the project surface fails closed instead of showing cached data. The generic connection and Typert carrier gain small extension points, but they are inert outside XAgent and are covered by ordinary-profile composition tests.

This note stays active because the trusted identity source, server-owned context, browser-cache prohibition, CSRF contribution boundary, and Slot-only UI ownership are constraints for later project artifacts, collaboration inboxes, and cross-project reporting.
