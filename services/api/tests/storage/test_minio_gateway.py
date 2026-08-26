from datetime import timedelta
from types import SimpleNamespace
from uuid import UUID

import minio
import pytest
from minio.versioningconfig import VersioningConfig

from app.storage.minio_gateway import MinioGateway, ObjectMetadata


class FakeMinio:
    def __init__(self) -> None:
        self.presigned_calls: list[tuple[str, str, str]] = []

    def presigned_put_object(self, bucket: str, key: str, expires: timedelta) -> str:
        self.presigned_calls.append(("PUT", bucket, key))
        return f"https://storage.test/PUT/{bucket}/{key}"


@pytest.fixture
def fake_minio() -> FakeMinio:
    return FakeMinio()


def test_gateway_only_signs_staging_put_and_never_get(fake_minio: FakeMinio) -> None:
    gateway = MinioGateway(fake_minio, bucket="jiaxin-private")
    upload_id = UUID("00000000-0000-0000-0000-000000000123")

    url = gateway.create_staging_put_url(f"staging/{upload_id}", timedelta(minutes=10))

    assert fake_minio.presigned_calls == [("PUT", "jiaxin-private", f"staging/{upload_id}")]
    assert "GET" not in url


def test_gateway_refuses_to_sign_non_staging_keys(fake_minio: FakeMinio) -> None:
    gateway = MinioGateway(fake_minio, bucket="jiaxin-private")

    with pytest.raises(ValueError, match="staging"):
        gateway.create_staging_put_url("artifacts/private-object", timedelta(minutes=10))


@pytest.mark.parametrize(
    "key",
    (
        "staging/",
        "staging/not-a-uuid",
        "staging/00000000-0000-0000-0000-000000000123/extra",
    ),
)
def test_gateway_refuses_to_sign_a_staging_prefix_instead_of_one_upload_object(
    fake_minio: FakeMinio,
    key: str,
) -> None:
    gateway = MinioGateway(fake_minio, bucket="jiaxin-private")

    with pytest.raises(ValueError, match="staging"):
        gateway.create_staging_put_url(key, timedelta(minutes=10))


def test_gateway_uses_configured_http_transport_for_local_minio(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: list[dict[str, object]] = []

    class FakeMinio:
        def __init__(self, endpoint: str, **kwargs: object) -> None:
            captured.append({"endpoint": endpoint, **kwargs})

        def bucket_exists(self, bucket: str) -> bool:
            assert bucket == "jiaxin-private"
            return True

        def get_bucket_policy(self, bucket: str) -> str:
            return '{"Statement": []}'

        def get_bucket_versioning(self, bucket: str) -> VersioningConfig:
            return VersioningConfig(status="Enabled")

        def set_bucket_lifecycle(self, bucket: str, config: object) -> None:
            assert bucket == "jiaxin-private"

    monkeypatch.setattr(minio, "Minio", FakeMinio)

    MinioGateway.from_settings(
        SimpleNamespace(
            MINIO_ENDPOINT="minio:9000",
            MINIO_PUBLIC_ENDPOINT="localhost:9000",
            MINIO_ACCESS_KEY="local-access-key",
            MINIO_SECRET_KEY="local-secret-key",
            MINIO_SECURE=False,
            MINIO_PUBLIC_SECURE=False,
            MINIO_REGION="us-east-1",
            MINIO_BUCKET="jiaxin-private",
            STAGING_EXPIRY_DAYS=1,
        )
    )

    assert captured[0] == {
        "endpoint": "minio:9000",
        "access_key": "local-access-key",
        "secret_key": "local-secret-key",
        "secure": False,
    }
    assert captured[1] == {
        "endpoint": "localhost:9000",
        "access_key": "local-access-key",
        "secret_key": "local-secret-key",
        "secure": False,
        "region": "us-east-1",
    }


def test_gateway_uses_browser_endpoint_only_for_staging_put(monkeypatch: pytest.MonkeyPatch) -> None:
    clients = []

    class FakeMinio:
        def __init__(self, endpoint: str, **kwargs: object) -> None:
            self.endpoint = endpoint
            clients.append(self)

        def bucket_exists(self, bucket: str) -> bool:
            return True

        def get_bucket_policy(self, bucket: str) -> str:
            return '{"Statement": []}'

        def get_bucket_versioning(self, bucket: str) -> VersioningConfig:
            return VersioningConfig(status="Enabled")

        def set_bucket_lifecycle(self, bucket: str, config: object) -> None:
            assert bucket == "jiaxin-private"

        def presigned_put_object(self, bucket: str, key: str, expires: timedelta) -> str:
            return f"https://{self.endpoint}/{bucket}/{key}"

    monkeypatch.setattr(minio, "Minio", FakeMinio)
    gateway = MinioGateway.from_settings(
        SimpleNamespace(
            MINIO_ENDPOINT="minio:9000",
            MINIO_PUBLIC_ENDPOINT="localhost:9000",
            MINIO_ACCESS_KEY="local-access-key",
            MINIO_SECRET_KEY="local-secret-key",
            MINIO_SECURE=False,
            MINIO_PUBLIC_SECURE=False,
            MINIO_REGION="us-east-1",
            MINIO_BUCKET="jiaxin-private",
            MINIO_BUCKET_QUOTA_BYTES=1024,
            STAGING_EXPIRY_DAYS=1,
        )
    )

    assert [client.endpoint for client in clients] == ["minio:9000", "localhost:9000"]
    upload_id = UUID("00000000-0000-0000-0000-000000000123")
    assert gateway.create_staging_put_url(
        f"staging/{upload_id}", timedelta(minutes=10)
    ).startswith("https://localhost:9000/")


def test_gateway_fails_closed_for_anonymous_bucket_policy() -> None:
    class PublicBucket:
        def bucket_exists(self, bucket: str) -> bool:
            return True

        def get_bucket_policy(self, bucket: str) -> str:
            return '{"Statement":[{"Principal":"*","Effect":"Allow","Action":"s3:GetObject"}]}'

        def get_bucket_versioning(self, bucket: str) -> VersioningConfig:
            return VersioningConfig(status="Enabled")

    with pytest.raises(RuntimeError, match="anonymous"):
        MinioGateway(PublicBucket(), bucket="jiaxin-private").ensure_bucket()


@pytest.mark.parametrize("status", (None, "Suspended"))
def test_gateway_rejects_a_bucket_without_enabled_versioning(status: str | None) -> None:
    class UnversionedBucket:
        def get_bucket_versioning(self, bucket: str) -> VersioningConfig:
            assert bucket == "jiaxin-private"
            return VersioningConfig(status=status)

    gateway = MinioGateway(UnversionedBucket(), bucket="jiaxin-private")

    with pytest.raises(RuntimeError, match="versioning"):
        gateway.require_versioning()


def test_gateway_enables_versioning_only_when_it_creates_the_bucket() -> None:
    states: list[str] = []

    class NewBucket:
        def bucket_exists(self, bucket: str) -> bool:
            return False

        def make_bucket(self, bucket: str) -> None:
            states.append("created")

        def set_bucket_versioning(
            self,
            bucket: str,
            config: VersioningConfig,
        ) -> None:
            states.append(config.status_string)

        def get_bucket_versioning(self, bucket: str) -> VersioningConfig:
            return VersioningConfig(status="Enabled")

        def get_bucket_policy(self, bucket: str) -> str:
            return '{"Statement": []}'

    MinioGateway(NewBucket(), bucket="jiaxin-private").ensure_bucket()

    assert states == ["created", "Enabled"]


def test_gateway_copies_only_the_verified_etag() -> None:
    captured = {}

    class ObjectClient:
        def get_bucket_versioning(self, bucket: str) -> VersioningConfig:
            return VersioningConfig(status="Enabled")

        def copy_object(self, bucket: str, target: str, source: object) -> object:
            captured["source"] = source
            return SimpleNamespace(version_id="target-version-1")

    gateway = MinioGateway(ObjectClient(), bucket="jiaxin-private")
    version_id = gateway.copy(
        "staging/upload-id",
        "artifacts/id/version",
        etag="verified-etag",
    )

    assert getattr(captured["source"], "match_etag") == "verified-etag"
    assert version_id == "target-version-1"


def test_gateway_does_not_copy_after_versioning_is_suspended() -> None:
    class SuspendedCopy:
        def get_bucket_versioning(self, bucket: str) -> VersioningConfig:
            return VersioningConfig(status="Suspended")

        def copy_object(self, bucket: str, target: str, source: object) -> object:
            raise AssertionError("copy must not start without enabled versioning")

    gateway = MinioGateway(SuspendedCopy(), bucket="jiaxin-private")

    with pytest.raises(RuntimeError, match="versioning"):
        gateway.copy("staging/upload-id", "artifacts/id/version", etag="etag")


def test_gateway_rejects_a_copy_without_a_target_version() -> None:
    class UnversionedCopy:
        def get_bucket_versioning(self, bucket: str) -> VersioningConfig:
            return VersioningConfig(status="Enabled")

        def copy_object(self, bucket: str, target: str, source: object) -> object:
            return SimpleNamespace(version_id=None)

    gateway = MinioGateway(UnversionedCopy(), bucket="jiaxin-private")

    with pytest.raises(RuntimeError, match="version"):
        gateway.copy("staging/upload-id", "artifacts/id/version", etag="etag")


def test_gateway_removes_only_the_owned_object_version() -> None:
    removed: list[tuple[str, str, str]] = []

    class VersionedRemoval:
        def remove_object(
            self,
            bucket: str,
            key: str,
            version_id: str | None = None,
        ) -> None:
            assert version_id is not None
            removed.append((bucket, key, version_id))

    gateway = MinioGateway(VersionedRemoval(), bucket="jiaxin-private")
    gateway.remove("artifacts/id/version", version_id="target-version-1")

    assert removed == [("jiaxin-private", "artifacts/id/version", "target-version-1")]


def test_gateway_proxies_private_object_operations() -> None:
    class ObjectClient:
        def get_bucket_versioning(self, bucket: str) -> VersioningConfig:
            return VersioningConfig(status="Enabled")

        def stat_object(self, bucket: str, key: str) -> SimpleNamespace:
            assert (bucket, key) == ("jiaxin-private", "staging/upload-id")
            return SimpleNamespace(size=7, content_type="text/plain", etag="etag-1")

        def copy_object(self, bucket: str, target: str, source: object) -> object:
            assert (bucket, target) == ("jiaxin-private", "artifacts/id/version")
            assert getattr(source, "object_name", None) == "staging/upload-id"
            return SimpleNamespace(version_id="target-version-1")

        def remove_object(
            self,
            bucket: str,
            key: str,
            version_id: str | None = None,
        ) -> None:
            assert (bucket, key) == ("jiaxin-private", "staging/upload-id")
            assert version_id is None

        def get_object(self, bucket: str, key: str):
            assert (bucket, key) == ("jiaxin-private", "artifacts/id/version")
            return SimpleNamespace(stream=lambda _size: iter((b"private", b"-content")), close=lambda: None, release_conn=lambda: None)

    gateway = MinioGateway(ObjectClient(), bucket="jiaxin-private")

    assert gateway.stat("staging/upload-id") == ObjectMetadata(size=7, content_type="text/plain", etag="etag-1")
    gateway.copy("staging/upload-id", "artifacts/id/version")
    gateway.remove("staging/upload-id")
    assert list(gateway.stream("artifacts/id/version")) == [b"private", b"-content"]
