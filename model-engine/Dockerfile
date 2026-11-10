FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends libeccodes0 libeccodes-tools libproj-dev proj-data proj-bin libgeos-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY model-engine/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY model-engine/app.py ./app.py
ENV PORT=8080 CACHE_DIR=/tmp/northstar-model-cache
CMD ["sh","-c","uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
