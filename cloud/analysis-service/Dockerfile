FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app:/app/pipeline

WORKDIR /app

COPY cloud/analysis-service/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY cloud/analysis-service/analysis_service ./analysis_service
COPY pipeline/gemini_harness ./pipeline/gemini_harness
COPY pipeline/stages.py ./pipeline/stages.py
COPY detections.schema.json ./detections.schema.json

RUN useradd --create-home --uid 10001 appuser
USER appuser

CMD ["sh", "-c", "exec uvicorn analysis_service.app:app --host 0.0.0.0 --port ${PORT:-8080}"]
