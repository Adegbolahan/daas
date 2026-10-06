FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY api/daas_api ./daas_api
COPY spec ./spec
COPY platform ./platform
ENV DAAS_SCHEMA_FILE=/app/spec/daas.schema.json \
    DAAS_PLATFORM_DIR=/app/platform
USER 1000
EXPOSE 8080
CMD ["uvicorn", "daas_api.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080"]
