# Use official Node.js 20 runtime as base image
FROM node:20-alpine

# Install system dependencies for Playwright/Chromium (alpine uses apk for faster installs)
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    && rm -rf /var/cache/apk/*

# Set Playwright env vars for alpine/Chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1

# Set working directory
WORKDIR /app

# Copy package files and install Node deps
COPY package.json package-lock.json* ./
RUN npm ci --only=production && npx playwright install chromium --with-deps

# Copy source code and build TypeScript
COPY . .
RUN npm run build

# Expose port
EXPOSE 10000

# Start the app (use your start command)
CMD ["npm", "start"]
