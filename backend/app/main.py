"""FastAPI application entry point.

The schema is managed by Alembic. Run `python migrate.py` before starting the
server (the Docker image does this on every start).
"""

from __future__ import annotations

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import check_production_settings, settings
from app.routers import auth, docs, kpi, tasks, users

# Refuse to start in production with a public or short signing key.
check_production_settings(settings)

app = FastAPI(
    title="TaskFlow API",
    description=(
        "Task tracking for a small team and its AI agents. Agents authenticate "
        "with a personal API token (`Authorization: Bearer qhub_...`) and name "
        "themselves in the `X-Agent` header on writes."
    ),
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(tasks.router)
app.include_router(docs.router)
app.include_router(users.router)
app.include_router(kpi.router)


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError) -> JSONResponse:
    """Turn stray domain ValueErrors into 422s instead of 500s."""
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, content={"detail": str(exc)}
    )


@app.get("/health", tags=["meta"])
def health() -> dict[str, str]:
    return {"status": "ok"}
