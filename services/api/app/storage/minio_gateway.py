import json
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import timedelta
from typing import Any
from uuid import UUID

from minio.versioningconfig import ENABLED, VersioningConfig
from urllib3 import PoolManager, Timeout


class ObjectVersioningUnavailable(RuntimeError):
    """The target bucket cannot provide an owned version for safe cleanup."""


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
    def from_settings(cls, configured_settings: Any) -> "MinioGateway":
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
            region=configured_settings.MINIO_REGION,
        )
        gateway = cls(internal_client, configured_settings.MINIO_BUCKET, public_client)
        gateway.ensure_bucket()
        gateway.configure_staging_lifecycle(configured_settings.STAGING_EXPIRY_DAYS)
        return gateway

    @classmethod
    def from_worker_settings(cls, configured_settings: Any) -> "MinioGateway":
        """Create the worker's private object client without browser signing setup."""

        from minio import Minio

        return cls(
            Minio(
                configured_settings.MINIO_ENDPOINT,
                access_key=configured_settings.MINIO_ACCESS_KEY,
                secret_key=configured_settings.MINIO_SECRET_KEY,
                secure=configured_settings.MINIO_SECURE,
                http_client=PoolManager(
                    timeout=Timeout(
                        connect=configured_settings.MINIO_TIMEOUT,
                        read=configured_settings.MINIO_TIMEOUT,
                    ),
                    retries=False,
                ),
            ),
            configured_settings.MINIO_BUCKET,
        )

    def ensure_bucket(self) -> None:
        created = not self._client.bucket_exists(self._bucket)
        if created:
            self._client.make_bucket(self._bucket)
            self._client.set_bucket_versioning(
                self._bucket,
                VersioningConfig(status=ENABLED),
            )
        self.require_versioning()
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

    def require_versioning(self) -> None:
        """Require enabled bucket versioning before fixed-key promotion."""

        configuration = self._client.get_bucket_versioning(self._bucket)
        if configuration.status != ENABLED:
            raise ObjectVersioningUnavailable("Bucket versioning must be Enabled")

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
        prefix, separator, upload_id = key.partition("/")
        try:
            canonical_upload_id = str(UUID(upload_id))
        except ValueError:
            canonical_upload_id = ""
        if (
            prefix != "staging"
            or separator != "/"
            or not upload_id
            or upload_id != canonical_upload_id
        ):
            raise ValueError("仅可为单个 staging/{upload_id} 对象签发上传 URL")
        return self._public_client.presigned_put_object(self._bucket, key, expires=expires)

    def stat(self, key: str) -> ObjectMetadata:
        object_stat = self._client.stat_object(self._bucket, key)
        return ObjectMetadata(
            size=object_stat.size,
            content_type=getattr(object_stat, "content_type", None),
            etag=getattr(object_stat, "etag", None),
        )

    def copy(
        self,
        source: str,
        target: str,
        etag: str | None = None,
    ) -> str:
        from minio.commonconfig import CopySource

        self.require_versioning()
        result = self._client.copy_object(
            self._bucket,
            target,
            CopySource(self._bucket, source, match_etag=etag),
        )
        version_id = getattr(result, "version_id", None)
        if not isinstance(version_id, str) or not version_id:
            raise ObjectVersioningUnavailable("Copy returned no target version")
        return version_id

    def remove(self, key: str, version_id: str | None = None) -> None:
        self._client.remove_object(self._bucket, key, version_id=version_id)

    def stream(self, key: str) -> Iterator[bytes]:
        response = self._client.get_object(self._bucket, key)
        try:
            yield from response.stream(32 * 1024)
        finally:
            try:
                response.close()
            finally:
                response.release_conn()

    def stream_bounded(self, key: str, *, max_bytes: int) -> Iterator[bytes]:
        """Stream one private object and stop before content can exceed `max_bytes`.

        @param key Exact private object key owned by the caller's durable record.
        @param max_bytes Maximum aggregate bytes yielded from the response.
        @returns Object chunks whose aggregate size does not exceed the limit.
        @raises ValueError If metadata or streamed bytes exceed the limit.
        """

        if max_bytes < 0:
            raise ValueError("object stream limit cannot be negative")
        metadata = self.stat(key)
        if metadata.size > max_bytes:
            raise ValueError("object exceeds the stream limit")
        total = 0
        for chunk in self.stream(key):
            total += len(chunk)
            if total > max_bytes:
                raise ValueError("object exceeds the stream limit")
            yield chunk
