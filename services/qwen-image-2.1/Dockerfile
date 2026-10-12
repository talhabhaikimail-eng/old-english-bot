FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LD_LIBRARY_PATH="/app/sd-cpp:$LD_LIBRARY_PATH"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    unzip \
    aria2 \
    procps \
    libgomp1 \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages \
    fastapi \
    uvicorn \
    httpx \
    pydantic

WORKDIR /app

# Download and extract stable-diffusion.cpp prebuilt binaries
RUN mkdir -p /app/sd-cpp && cd /app/sd-cpp && \
    curl -L -o sd.zip "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-908-88411ef/sd-master-88411ef-bin-Linux-Ubuntu-24.04-x86_64.zip" && \
    unzip sd.zip && \
    chmod +x sd-server sd-cli && \
    rm sd.zip

# Install cloudflared
RUN curl -L --output /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" && \
    chmod +x /usr/local/bin/cloudflared

# Copy application files
COPY webui.html /app/webui.html
COPY gateway.py /app/gateway.py
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

VOLUME ["/models", "/outputs"]

EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
