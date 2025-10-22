# Use lightweight Node.js 20 Alpine image
FROM node:20-alpine

# Install Playwright/Chromium dependencies
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Set Playwright environment variables
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PLAYWRIGHT_BROWSERS_PATH=/opt/render/.cache/ms-playwright \
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci && npm run install-browsers

# Copy source code and build
COPY . .
RUN npm run build

# Expose port
EXPOSE 10000

# Start the app
CMD ["npm", "start"]
