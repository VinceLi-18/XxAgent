"""Real API process with only external object metadata replaced for replay tests."""

import os
from datetime import timedelta
from uuid import UUID

from app.main import app
from app.services import artifacts
from app.storage.minio_gateway import ObjectMetadata


class ReplayObjectMetadata:
    """Each accepted staging UUID denotes the same one-byte test object."""

    def create_staging_put_url(self, key: str, expires: timedelta) -> str:
        UUID(key.removeprefix("staging/"))
        return "https://storage.test/put"

    def stat(self, key: str) -> ObjectMetadata:
        if os.environ.get("XAGENT_REPLAY_FORBID_STORAGE") == "yes":
            raise AssertionError("A saved replay must not consult object storage")
        UUID(key.removeprefix("staging/"))
        return ObjectMetadata(size=1, content_type="text/plain", etag="replay-etag")


artifacts._runtime_gateway = ReplayObjectMetadata

__all__ = ["app"]
