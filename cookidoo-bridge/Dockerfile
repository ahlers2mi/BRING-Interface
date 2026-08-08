FROM python:3.13-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY bridge.py ./

# Hier liegen die Sitzungs-Kekse, damit nicht jede Anfrage neu anmeldet.
VOLUME /data
ENV COOKIE_PATH=/data/cookies.json
EXPOSE 8099

CMD ["python", "-u", "bridge.py"]
