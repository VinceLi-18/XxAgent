from datetime import timedelta
from types import SimpleNamespace
from uuid import UUID

import minio
import pytest

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

    with pytest.raises(RuntimeError, match="anonymous"):
        MinioGateway(PublicBucket(), bucket="jiaxin-private").ensure_bucket()


def test_gateway_copies_only_the_verified_etag() -> None:
    captured = {}

    class ObjectClient:
        def copy_object(self, bucket: str, target: str, source: object) -> None:
            captured["source"] = source

    gateway = MinioGateway(ObjectClient(), bucket="jiaxin-private")
    gateway.copy("staging/upload-id", "artifacts/id/version", etag="verified-etag")

    assert getattr(captured["source"], "match_etag") == "verified-etag"


def test_gateway_proxies_private_object_operations() -> None:
    class ObjectClient:
        def stat_object(self, bucket: str, key: str) -> SimpleNamespace:
            assert (bucket, key) == ("jiaxin-private", "staging/upload-id")
            return SimpleNamespace(size=7, content_type="text/plain", etag="etag-1")

        def copy_object(self, bucket: str, target: str, source: object) -> None:
            assert (bucket, target) == ("jiaxin-private", "artifacts/id/version")
            assert getattr(source, "object_name", None) == "staging/upload-id"

        def remove_object(self, bucket: str, key: str) -> None:
            assert (bucket, key) == ("jiaxin-private", "staging/upload-id")

        def get_object(self, bucket: str, key: str):
            assert (bucket, key) == ("jiaxin-private", "artifacts/id/version")
            return SimpleNamespace(stream=lambda _size: iter((b"private", b"-content")), close=lambda: None, release_conn=lambda: None)

    gateway = MinioGateway(ObjectClient(), bucket="jiaxin-private")

    assert gateway.stat("staging/upload-id") == ObjectMetadata(size=7, content_type="text/plain", etag="etag-1")
    gateway.copy("staging/upload-id", "artifacts/id/version")
    gateway.remove("staging/upload-id")
    assert list(gateway.stream("artifacts/id/version")) == [b"private", b"-content"]
