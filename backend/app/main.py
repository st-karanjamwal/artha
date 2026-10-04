import asyncio
import contextlib
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import auth, backup_gdrive, vault
from .settings import get_settings

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
CSRF_HEADER = "x-artha-request"


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = app.dependency_overrides.get(get_settings, get_settings)()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    task = asyncio.create_task(backup_gdrive.scheduler_loop(settings))
    yield
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


def create_app() -> FastAPI:
    settings = get_settings()
    docs = "/api/docs" if settings.enable_docs else None
    app = FastAPI(
        title="Artha storage server",
        lifespan=lifespan,
        docs_url=docs,
        redoc_url=None,
        openapi_url="/api/openapi.json" if docs else None,
    )

    @app.middleware("http")
    async def csrf_and_headers(request: Request, call_next):
        # SameSite=Strict cookie + required custom header (cannot be sent cross-site
        # without a CORS preflight, which we never allow).
        if request.method in UNSAFE_METHODS and request.headers.get(CSRF_HEADER) != "1":
            return JSONResponse({"detail": "Missing request header"}, status_code=403)
        response = await call_next(request)
        response.headers.setdefault("Cache-Control", "no-store")
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    app.include_router(auth.router)
    app.include_router(vault.router)
    app.include_router(backup_gdrive.router)
    return app


app = create_app()
