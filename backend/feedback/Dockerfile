# The feedback service as a container, for ECS Fargate. Build from this folder after
# bin/sync-shared.sh has copied the shared modules in:
#   docker build -t feedback backend/feedback
FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY function.py server.py db.py http_utils.py security.py ./
ENV PORT=8080
EXPOSE 8080
USER nobody
CMD ["python", "server.py"]
