# Agent Note: XAgent asynchronous artifact processing and least-privilege worker

Status: implemented

English | [中文](2026-08-25-xagent-artifact-processing.zh.md)

## Problem

Artifact uploads require content identification, malware scanning, and object promotion after the API accepts the staged object. Performing this work in the API request would bind request latency and transaction lifetime to external services, while an in-process task would lose retry ownership when the process exits. Reusing the application database role would also give content-processing code access to account, authentication, Session, and project-membership data that it does not need.

## Decision

PostgreSQL owns the durable `ArtifactProcessingJob` queue, artifact-version scan state, and leases. Each version has one processing job. The worker claims due jobs with `FOR UPDATE SKIP LOCKED`, writes a random lease token and expiry, and increments the attempt in the claiming transaction. Heartbeat, retry, success, and terminal-failure updates match the job ID, version ID, lease token, and unexpired lease. The fifth failed attempt or expired fifth lease closes the job as `dead` and the version as `failed`; process exit leaves an expired lease reclaimable.

Artifact versions follow `pending → scanning → clean | quarantined | failed`. Only `clean` versions contain a final object reference and can be previewed or downloaded. A newer non-clean version does not replace the latest clean version as the default readable version. Manual retry atomically changes an eligible `failed` version back to `pending` and restores its unique ready job only while the staged object is still valid; quarantined versions cannot be retried.

Upload completion records the server-observed staging ETag, declared size, and staging retention deadline, then commits the Artifact, immutable Version, and ready job without reading content, calling ClamAV, or promoting an object. The worker rechecks the observed ETag and size before scanning, after the single content stream, and before promotion. That stream feeds the size and SHA-256 calculation, bounded MIME sample, and ClamAV scan. Only explicit `OK` and `FOUND` verdicts are terminal; storage, stream, timeout, and scan-protocol failures use the bounded retry policy, while identity or digest drift fails closed.

The final MinIO bucket must have versioning enabled. A clean object is copied to `artifacts/{artifact_id}/{version_id}` and the worker records the non-empty MinIO version ID returned for that copy. Publication then atomically verifies lease ownership before writing `clean` and `succeeded`. A stale worker or failed publication deletes only the exact object version it created, never the fixed key without a version ID.

Failed exact-version deletion transfers ownership to the persistent `ArtifactObjectCleanupJob` queue. Cleanup jobs accept only the fixed lowercase-UUID artifact key and a non-empty MinIO version ID, and use their own `FOR UPDATE SKIP LOCKED` lease, token, expiry, and bounded retry state. A dead cleanup job retains both object identifiers for operations. The worker processes at most one artifact job and one cleanup job per round; `--once` drains due work until the first empty round. A stop signal closes admission and waits for started processing to settle.

The `xagent_worker` database role is `NOINHERIT NOBYPASSRLS`. It receives only the table and column permissions needed to claim jobs, inspect staged artifact metadata, publish scan results, enqueue exact-version cleanup, and insert `executor_kind=artifact_worker` audit events. It cannot read account credentials, authentication records, Sessions, or project membership. The API role cannot claim worker jobs and writes only `executor_kind=account` audit events. API configuration does not read `DATABASE_WORKER_URL`; deployment passes worker credentials only to the worker and role-management processes.

FastAPI and PostgreSQL remain the authority for artifact scope, permission, immutable versions, scan state, audit, and signed reads. The Host service and browser panel access them through authenticated operations. Phase 3B exposes only the human upload, detail, preview, download, and retry paths: it registers no model-callable artifact tool and adds no artifact content or state to model requests or Session events.

## Alternatives considered

**Scan synchronously in the upload-completion request.** External storage and malware-service latency would extend the request transaction, and API process loss would leave no durable owner for unfinished work.

**Use FastAPI background tasks.** Process-local tasks do not survive service restart and cannot provide durable claim, heartbeat, retry, stale-owner rejection, or cleanup handoff semantics.

**Introduce Celery and Redis.** This would add a broker, publisher or transactional outbox, delivery recovery, and another operational authority before the artifact pipeline needs heterogeneous processing. PostgreSQL already owns the version commit point and can atomically create the processing job.

**Reuse the application database role for the worker.** The application role can read data required for Principal and project authorization. Content processing does not need that data, so reuse would violate least privilege and enlarge the impact of a worker credential disclosure.

**Keep cleanup ownership only in the worker stack frame.** A process exit after failed exact-version deletion would permanently lose the MinIO version ID. The persistent cleanup queue retains the exact deletion identity and retry state.

## Consequences

Upload requests return after a short database transaction, while scan and cleanup work survives API and worker restarts. Lease tokens prevent stale workers from publishing state or deleting another worker's object version. Versioned object ownership and persistent cleanup preserve a recoverable identity for every promoted object, and the dedicated worker role limits database exposure.

The deployment must operate PostgreSQL, a versioned private MinIO bucket, ClamAV, the independent worker role, and the worker process. Schema grants must evolve with any new worker input or result column. Dead cleanup jobs require an operational procedure using their retained object key and MinIO version ID. The browser currently observes scan progress by polling, and artifact retrieval, parsing, OCR, embedding, citation, and model tools remain separate future decisions.
