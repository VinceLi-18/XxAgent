from starlette.types import ASGIApp, Receive, Scope, Send


_ARTIFACT_CONTENT_PREFIX = "/api/v1/xagent/artifact-content/"


def _is_artifact_content_path(path: str) -> bool:
    if not path.startswith(_ARTIFACT_CONTENT_PREFIX):
        return False
    version_id = path[len(_ARTIFACT_CONTENT_PREFIX) :]
    return bool(version_id) and "/" not in version_id


class ArtifactContentAccessLogRedaction:
    """仅从服务器访问日志移除资料正文 signed-bearer query。"""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not _is_artifact_content_path(scope["path"]):
            await self.app(scope, receive, send)
            return
        query_string = scope.get("query_string", b"")
        if not query_string:
            await self.app(scope, receive, send)
            return

        application_scope = dict(scope)
        application_scope["query_string"] = query_string
        scope["query_string"] = b""
        await self.app(application_scope, receive, send)
