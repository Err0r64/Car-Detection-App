FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY prompt_service ./prompt_service

RUN useradd --create-home --uid 10001 appuser
USER appuser

CMD ["sh", "-c", "exec uvicorn prompt_service.app:app --host 0.0.0.0 --port ${PORT:-8080}"]

