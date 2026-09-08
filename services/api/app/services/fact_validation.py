"""Canonical hashing and UTF-8-aware validation for Fact operations."""

import hashlib
import json
import math
import re
from datetime import date

from app.models.facts import (
    FACT_FIELD_KEY_MAX_BYTES,
    FACT_LABEL_MAX_BYTES,
    FACT_REASON_MAX_BYTES,
    FACT_TEXT_MAX_BYTES,
)

_FIELD_KEY = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")
_CALENDAR_DATE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")


def canonical_sha256(value: object) -> str:
    """Return the SHA-256 digest of deterministic UTF-8 JSON."""
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def validate_field_key(value: str) -> str:
    """Return an ASCII Fact field key that fits the persistent byte limit."""
    if len(value.encode()) > FACT_FIELD_KEY_MAX_BYTES or _FIELD_KEY.fullmatch(value) is None:
        raise ValueError("invalid Fact field key")
    return value


def validate_label(value: str) -> str:
    """Return a non-empty label within the persistent UTF-8 byte limit."""
    byte_length = len(value.encode())
    if byte_length == 0 or byte_length > FACT_LABEL_MAX_BYTES:
        raise ValueError("invalid Fact label")
    return value


def validate_text_value(value: str) -> str:
    """Return Fact text within the persistent UTF-8 byte limit."""
    if len(value.encode()) > FACT_TEXT_MAX_BYTES:
        raise ValueError("invalid Fact text value")
    return value


def validate_reason(value: str) -> str:
    """Return a non-blank reason within the persistent UTF-8 byte limit."""
    if not value.strip() or len(value.encode()) > FACT_REASON_MAX_BYTES:
        raise ValueError("invalid Fact reason")
    return value


def validate_number(value: int | float) -> int | float:
    """Return a finite JSON number and reject booleans."""
    if isinstance(value, bool) or (
        isinstance(value, float) and not math.isfinite(value)
    ):
        raise ValueError("invalid Fact number")
    return value


def validate_calendar_date(value: str) -> str:
    """Return an exact Gregorian calendar date in YYYY-MM-DD form."""
    if _CALENDAR_DATE.fullmatch(value) is None:
        raise ValueError("invalid Fact date")
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise ValueError("invalid Fact date") from None
    if parsed.isoformat() != value:
        raise ValueError("invalid Fact date")
    return value
