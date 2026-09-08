"""Database models for the API."""

from app.models.artifact import Artifact, ArtifactProcessingJob, ArtifactVersion, StagingUpload
from app.models.auth import XAgentAccountCredential, XAgentAuthSession, XAgentPermissionRevision
from app.models.facts import (
    BusinessOutbox,
    FactOperationIdempotency,
    FactProposal,
    FactProposalEvidence,
    FactProposalReceipt,
    ProjectFactHead,
    ProjectFactRevision,
)
from app.models.retrieval import (
    ArtifactIndexJob,
    ArtifactSearchHead,
    ArtifactTextChunk,
    ArtifactTextIndex,
    XAgentAdmittedEvidence,
    XAgentDelegationNonce,
    XAgentCitedAnswerEvidence,
    XAgentRetrievalReceipt,
)
from app.models.xagent_session import XAgentIdempotencyKey, XAgentSession, XAgentSessionEvent
from app.models.workbench import (
    XAgentAccountCapabilityGrant,
    XAgentCapability,
    XAgentSessionProjectRef,
    XAgentWorkbenchPreference,
)

__all__ = (
    "Artifact",
    "ArtifactProcessingJob",
    "ArtifactVersion",
    "StagingUpload",
    "XAgentAccountCredential",
    "XAgentAuthSession",
    "XAgentPermissionRevision",
    "BusinessOutbox",
    "FactOperationIdempotency",
    "FactProposal",
    "FactProposalEvidence",
    "FactProposalReceipt",
    "ProjectFactHead",
    "ProjectFactRevision",
    "ArtifactIndexJob",
    "ArtifactSearchHead",
    "ArtifactTextChunk",
    "ArtifactTextIndex",
    "XAgentAdmittedEvidence",
    "XAgentDelegationNonce",
    "XAgentCitedAnswerEvidence",
    "XAgentRetrievalReceipt",
    "XAgentIdempotencyKey",
    "XAgentSession",
    "XAgentSessionEvent",
    "XAgentAccountCapabilityGrant",
    "XAgentCapability",
    "XAgentSessionProjectRef",
    "XAgentWorkbenchPreference",
)
