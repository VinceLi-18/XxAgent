"""Convert saved Artifact details without consulting live version state.

Revision ID: 021_artifact_detail_snapshots
Revises: 020_skill_test_policy
Create Date: 2026-09-13

Both directions run in Alembic's transaction. Validation errors disclose only
the operation and field rule, never the saved response or request identity.
"""

import json
import re
from datetime import datetime
from typing import Any
from uuid import UUID

from alembic import op
from sqlalchemy import text


revision = "021_artifact_detail_snapshots"
down_revision = "020_skill_test_policy"
branch_labels = None
depends_on = None

_COMPLETE = "artifact.upload.complete"
_RETRY = "artifact.version.retry"
_UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.IGNORECASE)
_INSTANT = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]"
    r"(?:\.[0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])"
)
_HASH = re.compile(r"[0-9a-f]{64}")
_STATUSES = {"pending", "scanning", "clean", "quarantined", "failed"}
_DETAIL_FIELDS = {"id", "display_name", "scope", "can_edit", "versions"}
_VERSION_FIELDS = {"id", "version", "original_filename", "uploaded_by", "status", "created_at"}
_VERSION_OPTIONAL = {"size", "content_type", "sha256"}


def _require(condition: bool, operation: str, rule: str) -> None:
    if not condition:
        raise ValueError(f"Artifact snapshot migration: {operation}: {rule}")


def _fields(value: Any, required: set[str], optional: set[str], operation: str, rule: str) -> None:
    _require(isinstance(value, dict) and required <= value.keys() <= required | optional, operation, rule)


def _identifier(value: Any, operation: str, rule: str) -> UUID:
    _require(isinstance(value, str) and _UUID.fullmatch(value) is not None, operation, rule)
    return UUID(value)


def _string(value: Any) -> bool:
    return isinstance(value, str) and 1 <= len(value) <= 255


def _integer(value: Any, minimum: int, maximum: int) -> bool:
    return type(value) is int and minimum <= value <= maximum


def _instant(value: Any) -> bool:
    if not isinstance(value, str) or _INSTANT.fullmatch(value) is None:
        return False
    try:
        datetime.fromisoformat(value)
    except ValueError:
        # The syntax check cannot reject impossible calendar dates.
        return False
    return True


def _convert(result: Any, operation: str, *, to_v2: bool) -> dict[str, Any]:
    _require(isinstance(result, dict), operation, "result.fields")
    detail = result.get("detail")
    required = _DETAIL_FIELDS | ({"latest_version", "latest_status"} if to_v2 else {"schema_version"})
    _fields(detail, required, {"latest_clean_version"} if to_v2 else set(), operation, "detail.fields")
    if not to_v2:
        _require(type(detail["schema_version"]) is int and detail["schema_version"] == 2, operation, "detail.schema_version")
    artifact_id = _identifier(detail["id"], operation, "detail.id")
    _require(_string(detail["display_name"]), operation, "detail.display_name")
    _require(type(detail["can_edit"]) is bool, operation, "detail.can_edit")
    scope = detail["scope"]
    _require(isinstance(scope, dict) and scope.get("kind") in ("private", "project"), operation, "detail.scope.kind")
    _fields(scope, {"kind", "project_id"} if scope["kind"] == "project" else {"kind"}, set(), operation, "detail.scope.fields")
    if scope["kind"] == "project":
        _identifier(scope["project_id"], operation, "detail.scope.project_id")

    versions = detail["versions"]
    _require(isinstance(versions, list) and 1 <= len(versions) <= 1000, operation, "detail.versions.count")
    ids = set()
    previous = None
    latest_clean = None
    for version in versions:
        _fields(version, _VERSION_FIELDS, _VERSION_OPTIONAL, operation, "detail.versions.fields")
        version_id = _identifier(version["id"], operation, "detail.versions.id")
        _require(version_id not in ids, operation, "detail.versions.unique_ids")
        ids.add(version_id)
        number = version["version"]
        _require(_integer(number, 1, 2**53 - 1), operation, "detail.versions.version")
        _require(previous is None or number < previous, operation, "detail.versions.order")
        previous = number
        _require(_string(version["original_filename"]), operation, "detail.versions.original_filename")
        _identifier(version["uploaded_by"], operation, "detail.versions.uploaded_by")
        status = version["status"]
        _require(isinstance(status, str) and status in _STATUSES, operation, "detail.versions.status")
        _require(_instant(version["created_at"]), operation, "detail.versions.created_at")
        if "size" in version:
            _require(_integer(version["size"], 0, 50 * 1024 * 1024), operation, "detail.versions.size")
        if "content_type" in version:
            _require(_string(version["content_type"]), operation, "detail.versions.content_type")
        if "sha256" in version:
            digest = version["sha256"]
            _require(isinstance(digest, str) and _HASH.fullmatch(digest) is not None, operation, "detail.versions.sha256")
            _require(status in {"clean", "quarantined"}, operation, "detail.versions.sha256_disclosure")
        if latest_clean is None and status == "clean":
            latest_clean = number

    outer_version_id = _identifier(result.get("version_id"), operation, "result.version_id")
    if operation == _COMPLETE:
        _require(outer_version_id == UUID(versions[0]["id"]), operation, "result.version_id_relation")
    else:
        _require(outer_version_id in ids, operation, "result.version_id_relation")
        outer_artifact_id = _identifier(result.get("artifact_id"), operation, "result.artifact_id")
        _require(outer_artifact_id == artifact_id, operation, "result.artifact_id_relation")

    converted = dict(detail)
    if to_v2:
        _require(type(detail["latest_version"]) is int and detail["latest_version"] == versions[0]["version"], operation, "detail.latest_version")
        _require(detail["latest_status"] == versions[0]["status"], operation, "detail.latest_status")
        _require(
            "latest_clean_version" not in detail if latest_clean is None else
            type(detail.get("latest_clean_version")) is int and detail["latest_clean_version"] == latest_clean,
            operation, "detail.latest_clean_version",
        )
        del converted["latest_version"]
        del converted["latest_status"]
        converted.pop("latest_clean_version", None)
        converted["schema_version"] = 2
    else:
        del converted["schema_version"]
        converted["latest_version"] = versions[0]["version"]
        converted["latest_status"] = versions[0]["status"]
        if latest_clean is not None:
            converted["latest_clean_version"] = latest_clean
    return converted


def _migrate(*, to_v2: bool) -> None:
    connection = op.get_bind()
    rows = connection.execute(text(
        "SELECT actor_id, operation, idempotency_key, result FROM public.xagent_idempotency_keys "
        "WHERE operation IN (:complete, :retry) "
        "ORDER BY operation, actor_id, idempotency_key FOR UPDATE"
    ), {"complete": _COMPLETE, "retry": _RETRY}).mappings()
    for row in rows:
        detail = _convert(row["result"], row["operation"], to_v2=to_v2)
        connection.execute(text(
            "UPDATE public.xagent_idempotency_keys "
            "SET result = jsonb_set(result, '{detail}', CAST(:detail AS jsonb), false) "
            "WHERE actor_id = :actor AND operation = :operation AND idempotency_key = :key"
        ), {
            "detail": json.dumps(detail), "actor": row["actor_id"],
            "operation": row["operation"], "key": row["idempotency_key"],
        })


def upgrade() -> None:
    _migrate(to_v2=True)


def downgrade() -> None:
    _migrate(to_v2=False)
