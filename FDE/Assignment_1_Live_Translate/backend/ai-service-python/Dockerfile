FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# HOST defaults to :: for Fly's IPv6 private network (<app>.internal). Docker
# Compose overrides it to 0.0.0.0 because its bridge network is IPv4.
EXPOSE 8000
ENV HOST=::
CMD ["sh", "-c", "uvicorn app:app --host \"$HOST\" --port 8000"]
