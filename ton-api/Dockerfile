# TON Center HTTP API v2 (Python, ton-http-api) for the local TON node.
# The C++ toncenter images die with SIGILL on Docker Desktop for Apple silicon (arm64 and amd64 alike); this one runs
# natively and uses the tonlib library the TON node puts into the shared volume, so both always match.
# Python stays on 3.11: pydantic v1 of ton-http-api fails on 3.12 and later. crc16 (a dependency) builds from source.
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir --root-user-action=ignore ton-http-api==2.0.68 \
 && apt-get purge -y build-essential && apt-get autoremove -y
EXPOSE 8081
# the settings come from these options; the TON_API_* env variables are overridden by the options' defaults (mainnet)
CMD ["ton-http-api", "--host", "0.0.0.0", "--port", "8081", "--liteserver-config", "/usr/share/data/global.config.json", "--cdll-path", "/usr/share/data/libtonlibjson.so", "--parallel-requests-per-liteserver", "8"]
