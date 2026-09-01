# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Copy root package files
COPY package*.json tsconfig.json ./

# Copy dashboard package files
COPY dashboard/package*.json ./dashboard/

# Install root and dashboard dependencies
RUN npm ci
RUN cd dashboard && npm ci

# Copy root source and dashboard source
COPY src ./src
COPY dashboard ./dashboard

# Build backend and frontend dashboard
RUN npm run build
RUN npm run dashboard:build

# Production stage
FROM node:24-alpine

WORKDIR /app

# Install system dependencies
RUN apk add --no-cache \
    tar \
    ffmpeg \
    python3 \
    py3-pip \
    bash \
    chromium \
    chromium-chromedriver

RUN apk add --no-cache --repository=https://dl-cdn.alpinelinux.org/alpine/edge/testing/ \
    cloudflared

# Set Puppeteer environment variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copy package files and requirements
COPY package*.json requirements.txt ./

# Install production dependencies only
RUN npm ci --omit=dev

# Install Python requirements
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Copy built files and dashboard from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dashboard/dist ./dashboard/dist

# Copy python scripts
COPY src/scripts ./src/scripts

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/

# Create auth_info directory and setup permissions
RUN mkdir -p auth_info && \
    chmod +x /usr/local/bin/docker-entrypoint.sh && \
    chown -R node:node /app

# Run as non-root user
USER node

# Expose port (4000 for dashboard)
EXPOSE 4000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
