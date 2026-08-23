import json
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from app.core.config import Settings, settings


@dataclass(frozen=True)
class ObjectMetadata:
    size: int
    content_type: str | None
    etag: str | None


class MinioGateway:
    def __init__(self, client: Any, bucket: str, public_client: Any | None = None) -> None:
        self._client = client
        self._public_client = public_client or client
        self._bucket = bucket

    @classmethod
    def from_settings(cls, configured_settings: Settings = settings) -> "MinioGateway":
        from minio import Minio

        internal_client = Minio(
                configured_settings.MINIO_ENDPOINT,
                access_key=configured_settings.MINIO_ACCESS_KEY,
                secret_key=configured_settings.MINIO_SECRET_KEY,
                secure=configured_settings.MINIO_SECURE,
            )
        public_client = Minio(
            configured_settings.MINIO_PUBLIC_ENDPOINT,
            access_key=configured_settings.MINIO_ACCESS_KEY,
            secret_key=configured_settings.MINIO_SECRET_KEY,
            secure=configured_settings.MINIO_PUBLIC_SECURE,
        )
        gateway = cls(internal_client, configured_settings.MINIO_BUCKET, public_client)
        gateway.ensure_bucket()
        gateway.configure_staging_lifecycle(configured_settings.STAGING_EXPIRY_DAYS)
        return gateway

    def ensure_bucket(self) -> None:
        if not self._client.bucket_exists(self._bucket):
            self._client.make_bucket(self._bucket)
        try:
            policy = self._client.get_bucket_policy(self._bucket)
        except Exception as exc:
            if getattr(exc, "code", None) != "NoSuchBucketPolicy":
                raise RuntimeError("Cannot verify bucket anonymity") from exc
            policy = ""
        try:
            statements = json.loads(policy).get("Statement", []) if policy else []
        except (TypeError, ValueError) as exc:
            raise RuntimeError("Cannot verify bucket anonymity") from exc
        if any(
            statement.get("Effect") == "Allow" and statement.get("Principal") in ("*", {"AWS": "*"})
            for statement in statements
        ):
            raise RuntimeError("Bucket permits anonymous access")

    def configure_staging_lifecycle(self, expiry_days: int) -> None:
        from minio.commonconfig import Filter
        from minio.lifecycleconfig import Expiration, LifecycleConfig, Rule

        self._client.set_bucket_lifecycle(
            self._bucket,
            LifecycleConfig(
                [
                    Rule(
                        status="Enabled",
                        rule_filter=Filter(prefix="staging/"),
                        rule_id="expire-staging-uploads",
                        expiration=Expiration(days=expiry_days),
                    )
                ]
            ),
        )

    def create_staging_put_url(self, key: str, expires: timedelta) -> str:
        if not key.startswith("staging/"):
            raise ValueError("Only staging keys can receive upload URLs")
        return self._public_client.presigned_put_object(self._bucket, key, expires=expires)

    def stat(self, key: str) -> ObjectMetadata:
        object_stat = self._client.stat_object(self._bucket, key)
        return ObjectMetadata(
            size=object_stat.size,
            content_type=getattr(object_stat, "content_type", None),
            etag=getattr(object_stat, "etag", None),
        )

    def copy(self, source: str, target: str, etag: str | None = None) -> None:
        from minio.commonconfig import CopySource

        self._client.copy_object(
            self._bucket,
            target,
            CopySource(self._bucket, source, match_etag=etag),
        )

    def remove(self, key: str) -> None:
        self._client.remove_object(self._bucket, key)

    def stream(self, key: str) -> Iterator[bytes]:
        response = self._client.get_object(self._bucket, key)
        try:
            yield from response.stream(32 * 1024)
        finally:
            response.close()
            response.release_conn()
