import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest


_SCRIPT = Path(__file__).resolve().parents[1] / "verify_model_snapshot.py"
_REVISION = "5617a9f61b028005a4858fdac845db406aefb181"


def _write_manifest(directory: Path, files: dict[str, bytes]) -> Path:
    manifest = directory / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "model_id": "BAAI/bge-m3",
                "revision": _REVISION,
                "source": f"https://huggingface.co/BAAI/bge-m3/tree/{_REVISION}",
                "files": [
                    {
                        "path": name,
                        "size": len(content),
                        "sha256": hashlib.sha256(content).hexdigest(),
                        "huggingface_blob_id": "0" * 40,
                    }
                    for name, content in files.items()
                ],
            }
        ),
        encoding="utf-8",
    )
    return manifest


def _snapshot(cache: Path) -> Path:
    return (
        cache
        / "hub"
        / "models--BAAI--bge-m3"
        / "snapshots"
        / _REVISION
    )


def _model_repository(cache: Path) -> Path:
    return _snapshot(cache).parents[1]


def _model_locks(cache: Path) -> Path:
    return cache / "hub" / ".locks" / "models--BAAI--bge-m3"


def _verify(cache: Path, manifest: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(_SCRIPT),
            *extra,
            "--cache-dir",
            str(cache),
            "--manifest",
            str(manifest),
        ],
        capture_output=True,
        text=True,
        check=False,
    )


def test_exact_snapshot_passes_content_verification(tmp_path: Path) -> None:
    files = {"config.json": b"config", "weights.bin": b"weights"}
    manifest = _write_manifest(tmp_path, files)
    cache = tmp_path / "cache"
    snapshot = _snapshot(cache)
    snapshot.mkdir(parents=True)
    blobs = snapshot.parents[1] / "blobs"
    blobs.mkdir()
    for name, content in files.items():
        blob = blobs / name
        blob.write_bytes(content)
        (snapshot / name).symlink_to(blob)
    refs = snapshot.parents[1] / "refs"
    refs.mkdir()
    (refs / "main").write_text(_REVISION, encoding="utf-8")
    locks = cache / "hub" / ".locks"
    locks.mkdir()
    (locks / "download.lock").write_text("", encoding="utf-8")

    completed = _verify(cache, manifest)

    assert completed.returncode == 0
    assert completed.stdout == "verified BAAI/bge-m3@5617a9f61b028005a4858fdac845db406aefb181: 2 files\n"
    assert completed.stderr == ""


def test_missing_or_corrupt_snapshot_fails_closed(tmp_path: Path) -> None:
    files = {"config.json": b"config", "weights.bin": b"weights"}
    manifest = _write_manifest(tmp_path, files)
    cache = tmp_path / "cache"
    snapshot = _snapshot(cache)

    absent = _verify(cache, manifest)
    allowed_absent = _verify(cache, manifest, "--allow-absent")
    snapshot.parent.mkdir(parents=True)
    snapshot.symlink_to("missing-snapshot", target_is_directory=True)
    broken_snapshot = _verify(cache, manifest, "--allow-absent")
    snapshot.unlink()
    snapshot.mkdir(parents=True)
    (snapshot / "config.json").write_bytes(files["config.json"])
    incomplete = _verify(cache, manifest, "--allow-absent")
    (snapshot / "weights.bin").write_bytes(b"corrupt")
    corrupt = _verify(cache, manifest)

    assert absent.returncode == 1
    assert "snapshot is absent" in absent.stderr
    assert allowed_absent.returncode == 0
    assert allowed_absent.stdout == "snapshot absent; immutable download required\n"
    assert broken_snapshot.returncode == 1
    assert "snapshot path is invalid" in broken_snapshot.stderr
    assert incomplete.returncode == 1
    assert "missing required file: weights.bin" in incomplete.stderr
    assert corrupt.returncode == 1
    assert "content differs: weights.bin" in corrupt.stderr


def test_boolean_schema_version_is_rejected(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path, {"config.json": b"config"})
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["schema_version"] = True
    manifest.write_text(json.dumps(payload), encoding="utf-8")

    completed = _verify(tmp_path / "cache", manifest, "--allow-absent")

    assert completed.returncode == 1
    assert "invalid manifest metadata" in completed.stderr


@pytest.mark.parametrize(
    "unexpected_path",
    [
        "model.safetensors",
        "model.safetensors.index.json",
        "adapter_config.json",
        "adapter/adapter_model.bin",
    ],
)
def test_unmanifested_loadable_file_fails_closed(
    tmp_path: Path,
    unexpected_path: str,
) -> None:
    files = {"config.json": b"config", "pytorch_model.bin": b"weights"}
    manifest = _write_manifest(tmp_path, files)
    cache = tmp_path / "cache"
    snapshot = _snapshot(cache)
    snapshot.mkdir(parents=True)
    for name, content in files.items():
        (snapshot / name).write_bytes(content)
    unexpected = snapshot / unexpected_path
    unexpected.parent.mkdir(parents=True, exist_ok=True)
    unexpected.write_bytes(b"alternate")

    completed = _verify(cache, manifest)

    assert completed.returncode == 1
    assert f"unexpected snapshot entry: {unexpected_path}" in completed.stderr


@pytest.mark.parametrize("symlink_kind", ["file", "directory"])
def test_unmanifested_symlink_alias_fails_closed(
    tmp_path: Path,
    symlink_kind: str,
) -> None:
    files = {"config.json": b"config", "pytorch_model.bin": b"weights"}
    manifest = _write_manifest(tmp_path, files)
    cache = tmp_path / "cache"
    snapshot = _snapshot(cache)
    snapshot.mkdir(parents=True)
    for name, content in files.items():
        (snapshot / name).write_bytes(content)
    alias = snapshot / ("model.safetensors" if symlink_kind == "file" else "adapter")
    target = snapshot / "config.json" if symlink_kind == "file" else tmp_path / "adapter"
    if symlink_kind == "directory":
        target.mkdir()
    alias.symlink_to(target, target_is_directory=symlink_kind == "directory")

    completed = _verify(cache, manifest)

    assert completed.returncode == 1
    assert f"unexpected snapshot entry: {alias.name}" in completed.stderr


@pytest.mark.parametrize(
    "poison",
    [
        "blob",
        "ref",
        "alternate-snapshot",
        "model-lock",
        "empty-repository",
        "empty-model-locks",
        "repository-symlink",
        "broken-repository-symlink",
        "model-locks-symlink",
        "broken-model-locks-symlink",
        "blob-symlink",
    ],
)
def test_allow_absent_rejects_non_cold_model_repository(
    tmp_path: Path,
    poison: str,
) -> None:
    manifest = _write_manifest(tmp_path, {"config.json": b"config"})
    cache = tmp_path / "cache"
    repository = _model_repository(cache)
    if poison == "blob":
        target = repository / "blobs" / "unverified"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"poison")
    elif poison == "ref":
        target = repository / "refs" / "main"
        target.parent.mkdir(parents=True)
        target.write_text("unverified", encoding="utf-8")
    elif poison == "alternate-snapshot":
        target = repository / "snapshots" / ("f" * 40) / "config.json"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"poison")
    elif poison == "model-lock":
        target = _model_locks(cache) / "unverified.lock"
        target.parent.mkdir(parents=True)
        target.write_text("", encoding="utf-8")
    elif poison == "empty-repository":
        repository.mkdir(parents=True)
    elif poison == "empty-model-locks":
        _model_locks(cache).mkdir(parents=True)
    elif poison == "repository-symlink":
        target = tmp_path / "linked-repository"
        target.mkdir()
        repository.parent.mkdir(parents=True)
        repository.symlink_to(target, target_is_directory=True)
    elif poison == "broken-repository-symlink":
        repository.parent.mkdir(parents=True)
        repository.symlink_to(tmp_path / "missing", target_is_directory=True)
    elif poison == "model-locks-symlink":
        target = tmp_path / "linked-model-locks"
        target.mkdir()
        model_locks = _model_locks(cache)
        model_locks.parent.mkdir(parents=True)
        model_locks.symlink_to(target, target_is_directory=True)
    elif poison == "broken-model-locks-symlink":
        model_locks = _model_locks(cache)
        model_locks.parent.mkdir(parents=True)
        model_locks.symlink_to(tmp_path / "missing", target_is_directory=True)
    elif poison == "blob-symlink":
        target = tmp_path / "linked-blob"
        target.write_bytes(b"poison")
        blob = repository / "blobs" / "unverified"
        blob.parent.mkdir(parents=True)
        blob.symlink_to(target)
    else:
        raise AssertionError(f"unknown poison fixture: {poison}")

    completed = _verify(cache, manifest, "--allow-absent")

    assert completed.returncode == 1
    assert "model repository cache is not cold" in completed.stderr


def test_allow_absent_accepts_cold_repository_with_unrelated_cache_metadata(
    tmp_path: Path,
) -> None:
    manifest = _write_manifest(tmp_path, {"config.json": b"config"})
    cache = tmp_path / "cache"
    other_blob = cache / "hub" / "models--other--model" / "blobs" / "trusted"
    other_blob.parent.mkdir(parents=True)
    other_blob.write_bytes(b"other model")
    other_lock = cache / "hub" / ".locks" / "models--other--model" / "trusted.lock"
    other_lock.parent.mkdir(parents=True)
    other_lock.write_text("", encoding="utf-8")

    completed = _verify(cache, manifest, "--allow-absent")

    assert completed.returncode == 0
    assert completed.stdout == "snapshot absent; immutable download required\n"
    assert completed.stderr == ""
