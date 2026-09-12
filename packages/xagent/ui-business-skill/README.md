# @xagent/dsh-ui-business-skill

English | [中文](README.zh.md)

Optional project Business Skill governance in the workbench's single `xagent.workbench.skills` Slot. The plugin mounts the generated `xagentBusinessSkill` Remote, waits for the parent Slot declaration, and removes its occupant and requests when that declaration or plugin is disposed. The invariant companion checks the actual Remote identity, Slot component and injected snapshot relationship.

The compact Skill list opens a release dossier with a data-driven Draft / Test / Publish / Authorize track. Specialists can create and edit Markdown drafts, choose from the closed primary-tool catalog, run a scenario, inspect isolated transcripts and record verdicts. Managers additionally publish, authorize, remove authorization, select an immutable version and retire a Skill. Server authorization remains authoritative. Publication confirmation names the exact revision, qualifying run and production write permissions; retirement explains its permanent state and immediate removal of authorization. Historical test reports display their immutable `unexecutedWriteTools`, independently of current draft edits.

The controller retains only the active account, project, ordinary Session, role and physical connection generation in memory. Account, project, Session, tab and connection changes abort requests and discard old responses. Disposal removes subscriptions, cancels requests and awaits their settlement. Catalog pages deduplicate by slug and sort deterministically. Each Skill selection owns independent history and transcript requests and page locks; changing selection cancels them even when returning to the same slug. Transcript reads include sequence zero and advance from the server's last-sequence cursor. No Skill content or retry identity enters browser storage.

Each new mutation receives a fresh idempotency key. Only an uncertain transport outcome exposes an explicit retry with the original key and immutable request. Mutation results distinguish authoritative success, rejection, uncertainty, cancellation and refusal to start. Creation inputs remain editable after validation or duplicate-name errors and survive same-scope refreshes; only successful creation resets the form. Security errors require refresh without discarding the unsaved form. Revision or policy conflicts reload authoritative detail while retaining the test scenario; the editor never guesses a revision or retries an obsolete overwrite. Changing account, project, Session, role or connection generation clears retained inputs. Empty, loading, error, blocked and ready states remain explicit. Keyboard tab navigation, labelled controls, visible focus and a reduced-motion override support the responsive list/detail layout.

## Model Experience

### Human governance

#### What the model sees

This package adds no model input. `@xagent/dsh-business-skill` owns isolated draft execution and production instruction loading; this package renders their public records.

#### Token effect

The browser package adds no prompt or output tokens.

#### KV Cache effect

The package does not read or write model KV cache.

## Known Limitations and Deferred Work

- The view provides bounded lists and histories, not bulk editing or search.
- Reload and reconnect restore records from the authorized Remote; there is no offline mode.
- Business profile composition and real-server browser acceptance are separate integration surfaces.
