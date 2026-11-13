# Three stages:
#   base    - dependencies and app code
#   test    - runs the test suite at build time; deploy.sh builds it first, so a
#             failing test stops the deploy before any container changes
#   runtime - what runs on the server (no tests inside)
FROM python:3.12-slim AS base
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY migrations ./migrations
COPY alembic.ini migrate.py backup.py seed.py ./

FROM base AS test
COPY tests ./tests
COPY pytest.ini ./
RUN python -m pytest -q

FROM base AS runtime
RUN mkdir -p /data
EXPOSE 8000
# Migrate first; uvicorn starts only if the schema is current.
# One worker: SQLite does not take concurrent writers well.
# --root-path /api lets /api/docs load openapi.json from the right URL.
CMD ["sh", "-c", "python migrate.py && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --root-path /api --proxy-headers --forwarded-allow-ips '*'"]
