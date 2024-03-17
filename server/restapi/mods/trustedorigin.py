import typing

from urllib.parse import urlparse
from starlette.datastructures import Headers
from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send

ENFORCE_URL_ORIGIN_FORMAT = "Input origins must be well-formed URLs, i.e. https://google.com or https://www.google.com."


class TrustedOriginMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        allowed_origins: typing.Optional[typing.Sequence[str]] = None,
        port: typing.Optional[int] = None,
    ) -> None:
        schemas = ['http', 'https']
        local_origins = [f'{schema}://{origin}' for schema in schemas for origin in ['127.0.0.1', 'localhost']]
        if port is not None:
            local_origins = [f'{origin}:{port}' for origin in local_origins]

        self.allowed_origins: set[str] = set()
        if allowed_origins is not None:
            for origin in allowed_origins:
                url = urlparse(origin)
                assert url.scheme, ENFORCE_URL_ORIGIN_FORMAT
                valid_origin = f'{url.scheme}://{url.hostname}'
                if url.port:
                    valid_origin += f':{url.port}'
                self.allowed_origins.add(valid_origin)
        self.allowed_origins.update(local_origins)
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in (
            "http",
            "websocket",
        ):  # pragma: no cover
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        origin = headers.get("origin", "")
        # Origin header is not present for same origin
        if not origin or origin in self.allowed_origins:
            await self.app(scope, receive, send)
            return

        response = PlainTextResponse("Invalid origin header", status_code=400)
        await response(scope, receive, send)
