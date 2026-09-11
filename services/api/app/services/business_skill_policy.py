"""Deterministic production and read-only test tool resolution."""

from dataclasses import dataclass

from app.models.business_skills import BUSINESS_SKILL_PRIMARY_TOOLS, BUSINESS_SKILL_TOOL_POLICY_VERSION
from app.services.fact_validation import canonical_sha256


@dataclass(frozen=True)
class BusinessSkillPolicy:
    complete_tools: tuple[str, ...]
    test_tools: tuple[str, ...]
    unexecuted_write_tools: tuple[str, ...]
    digest: str


def resolve_business_skill_policy(primary_tools: list[str]) -> BusinessSkillPolicy:
    """Reject unsupported selections and hash the version plus complete production set."""
    if primary_tools != sorted(set(primary_tools)) or not set(primary_tools) <= BUSINESS_SKILL_PRIMARY_TOOLS:
        raise ValueError("primary_tools must be sorted, unique, and supported")
    complete = set(primary_tools) | {"skill"}
    if "search_artifacts" in complete:
        complete.add("submit_cited_answer")
    tools = tuple(sorted(complete))
    return BusinessSkillPolicy(
        complete_tools=tools,
        test_tools=tuple(tool for tool in tools if tool != "propose_fact"),
        unexecuted_write_tools=("propose_fact",) if "propose_fact" in tools else (),
        digest=canonical_sha256({"version": BUSINESS_SKILL_TOOL_POLICY_VERSION, "complete_tools": list(tools)}),
    )


def business_skill_content_digest(description: str, instructions: str, primary_tools: list[str]) -> str:
    """Display names do not invalidate test evidence; authored content and tools do."""
    return canonical_sha256({"description": description, "instructions": instructions, "primary_tools": primary_tools})
