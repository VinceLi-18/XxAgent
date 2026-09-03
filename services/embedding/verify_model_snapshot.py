"""Verify every runtime BGE-M3 snapshot file against committed immutable metadata."""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path, PurePosixPath
from typing import TypedDict, cast


_SHA256 = re.compile(r"[0-9a-f]{64}")
_BLOB_ID = re.compile(r"[0-9a-f]{40}")


class SnapshotVerificationError(ValueError):
    """The configured snapshot or its trusted manifest is incomplete or invalid."""


class SnapshotFile(TypedDict):
    """One validated immutable runtime file."""

    path: str
    size: int
    sha256: str
    huggingface_blob_id: str


def _closed_object(
    value: object,
    keys: set[str],
    description: str,
) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise SnapshotVerificationError(f"invalid {description}")
    record = cast(dict[str, object], value)
    if set(record) != keys:
        raise SnapshotVerificationError(f"invalid {description}")
    return record


def _load_manifest(path: Path) -> tuple[str, str, list[SnapshotFile]]:
    try:
        payload: object = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SnapshotVerificationError("manifest cannot be read") from error
    manifest = _closed_object(
        payload,
        {"schema_version", "model_id", "revision", "source", "files"},
        "manifest",
    )
    model_id = manifest["model_id"]
    revision = manifest["revision"]
    source = manifest["source"]
    files = manifest["files"]
    if (
        isinstance(manifest["schema_version"], bool)
        or not isinstance(manifest["schema_version"], int)
        or manifest["schema_version"] != 1
        or model_id != "BAAI/bge-m3"
        or not isinstance(revision, str)
        or not _BLOB_ID.fullmatch(revision)
        or not isinstance(source, str)
        or revision not in source
        or not isinstance(files, list)
        or not files
    ):
        raise SnapshotVerificationError("invalid manifest metadata")
    entries: list[SnapshotFile] = []
    names: set[str] = set()
    for raw_entry in files:
        entry = _closed_object(
            raw_entry,
            {"path", "size", "sha256", "huggingface_blob_id"},
            "file entry",
        )
        name = entry["path"]
        relative = PurePosixPath(name) if isinstance(name, str) else PurePosixPath("/")
        if (
            not isinstance(name, str)
            or not name
            or relative.is_absolute()
            or ".." in relative.parts
            or name in names
            or isinstance(entry["size"], bool)
            or not isinstance(entry["size"], int)
            or entry["size"] < 0
            or not isinstance(entry["sha256"], str)
            or not _SHA256.fullmatch(entry["sha256"])
            or not isinstance(entry["huggingface_blob_id"], str)
            or not _BLOB_ID.fullmatch(entry["huggingface_blob_id"])
        ):
            raise SnapshotVerificationError("invalid file entry")
        names.add(name)
        entries.append(cast(SnapshotFile, entry))
    return model_id, revision, entries


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
    except OSError as error:
        raise SnapshotVerificationError(f"cannot read required file: {path.name}") from error
    return digest.hexdigest()


def verify_snapshot(
    cache_dir: Path,
    manifest_path: Path,
    *,
    allow_absent: bool = False,
) -> str:
    """Verify the exact immutable snapshot used by inference and tokenization.

    @param cache_dir Hugging Face cache root mounted into all retrieval services.
    @param manifest_path Reviewed immutable revision and per-file digest manifest.
    @param allow_absent Permit only a wholly absent snapshot so an official download can start.
    @returns A stable human-readable verification result.
    @raises SnapshotVerificationError If metadata or any present snapshot content is invalid.
    """
    model_id, revision, entries = _load_manifest(manifest_path)
    snapshot = (
        cache_dir
        / "hub"
        / "models--BAAI--bge-m3"
        / "snapshots"
        / revision
    )
    if snapshot.is_symlink() and not snapshot.exists():
        raise SnapshotVerificationError("snapshot path is invalid")
    if not snapshot.exists():
        if allow_absent:
            return "snapshot absent; immutable download required"
        raise SnapshotVerificationError("snapshot is absent")
    if not snapshot.is_dir():
        raise SnapshotVerificationError("snapshot path is not a directory")
    for entry in entries:
        candidate = snapshot.joinpath(*PurePosixPath(entry["path"]).parts)
        if not candidate.is_file():
            raise SnapshotVerificationError(f"missing required file: {entry['path']}")
        try:
            size = candidate.stat().st_size
        except OSError as error:
            raise SnapshotVerificationError(
                f"cannot inspect required file: {entry['path']}"
            ) from error
        if size != entry["size"] or _digest(candidate) != entry["sha256"]:
            raise SnapshotVerificationError(f"content differs: {entry['path']}")
    return f"verified {model_id}@{revision}: {len(entries)} files"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Verify the immutable BGE-M3 Hugging Face snapshot",
    )
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path(__file__).with_name("bge-m3-snapshot.json"),
    )
    parser.add_argument("--allow-absent", action="store_true")
    return parser


def main() -> int:
    """Run snapshot verification and return a process exit status."""
    args = _parser().parse_args()
    try:
        print(
            verify_snapshot(
                args.cache_dir,
                args.manifest,
                allow_absent=args.allow_absent,
            )
        )
    except SnapshotVerificationError as error:
        print(f"model snapshot verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
