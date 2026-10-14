FROM mirror.gcr.io/library/python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258
WORKDIR /opt/browser-publisher
COPY services/browser-publisher/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY services/browser-publisher ./
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 1200:1200
CMD ["python", "server.py"]
