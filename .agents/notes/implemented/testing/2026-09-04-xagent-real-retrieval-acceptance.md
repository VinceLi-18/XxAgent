# Agent Note: XAgent real CPU retrieval acceptance

Status: implemented

English | [中文](2026-09-04-xagent-real-retrieval-acceptance.zh.md)

## Problem

XAgent retrieval depends on PostgreSQL extensions, object storage, malware scanning, asynchronous artifact and index workers, a fixed tokenizer, and CPU embedding inference. Unit tests can validate each component while missing service-ordering defects, database-role drift, model-cache failures, stale lease publication, or differences between synthetic vectors and the deployed BGE-M3 model. A required end-to-end lane must exercise the assembled path without giving CI a public embedding endpoint, unbounded model downloads, or leftover Docker resources.

## Decision

The API Compose files define one private CPU retrieval topology. PostgreSQL 16 uses the pgvector image pinned by digest. The embedding service builds from the locked `services/embedding` project, publishes no host port, limits CPU and memory, and is healthy only after the immutable `BAAI/bge-m3` revision produces a 1024-dimensional vector. API and worker depend on that health result and use its service-network origin. Only the worker receives the worker database role. Embedding writes the shared Hugging Face cache; API and worker mount it read-only because both load the pinned tokenizer. Online retrieval remains the default for missing files, while verified complete caches may set `HF_HUB_OFFLINE=true`. Docker and Python package inputs both exclude the local cache.

The required pull-request lane runs the real upload, scan, index, search, receipt, Session evidence, citation authorization, and citation resolution path. Its bilingual cases cover semantic, English lexical, and Chinese trigram retrieval. Database-backed fixtures exercise the exact forty-candidate cap and deterministic tie order using vectors produced by the running embedding service. Version replacement keeps the current generation searchable until the next ready index switches the head atomically. Binary, unsupported, quarantined, superseded, and stale work cannot publish a searchable head.

Worker crash recovery uses an observable lease instead of a sleep. The test pauses the real embedding service, uploads a small valid document, waits until the index job holds its first lease, kills the worker with SIGKILL, and confirms there is no head. It unpauses embedding, waits for actual service health, restarts the worker, and requires the same job to succeed on attempt two after lease expiry. Every polling loop, HTTP operation, Compose command, service health check, and CI job has an explicit bound.

The CI step installs an unconditional exit trap before startup. Failure diagnostics run before teardown, then Compose removes volumes and orphans. Exact Compose project-label queries require container, volume, and network results to be empty, so a successful test command cannot conceal cleanup failure. The model cache lives in the runner's temporary directory and is keyed by the immutable model revision and embedding lockfile.

The [RAG retrieval proposal](../../proposed/architecture/2026-08-28-xagent-rag-retrieval.md) continues to own the runtime data, authorization, receipt, and citation design. This note owns the assembled deployment and acceptance strategy and does not supersede that proposal.

## Alternatives considered

**Mock the embedding service or seed arbitrary vectors.** This would not prove model loading, tokenizer compatibility, output dimension, real inference, or API and worker network wiring. The lane calls the running pinned model; direct database setup is limited to cardinality and ordering cases and still uses its real query vector.

**Publish the embedding port for host-driven tests.** This would make a private implementation service reachable outside the Compose network and certify a topology different from deployment. Tests invoke embedding from a Compose container when they need its vector directly.

**Bake model weights into a mutable local image.** This would create another large artifact and provenance lifecycle. A revision-keyed cache preserves normal official-source behavior and allows offline verification when its files have been checked independently.

**Use a large document or a fixed delay to catch a worker lease.** CPU speed changes whether either technique observes the intended state and can make valid inference exceed an artificially short lease. Pausing the real dependency holds the job at a visible lease, while the small payload keeps the post-expiry retry within the configured lease.

## Consequences

Pull requests gain a bounded, non-mock signal for the full XAgent retrieval stack, including destructive worker recovery and exact cleanup. The lane is intentionally Linux-only and costly enough to remain separate from the ordinary API unit job. A cold CI cache still downloads the immutable revision from the official source, so availability and bandwidth can affect that first run; subsequent runs reuse the revision-and-lock keyed cache. Any change to the model revision, tokenizer use, service dependencies, database roles, lease behavior, or Compose project name must update this lane and its cleanup assertions together.
