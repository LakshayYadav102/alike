# Dockerfile
FROM node:22.16.0

# Install system dependencies for Playwright
RUN apt-get update && apt-get install -y \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    && apt-get clean

# Set working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package.json .
RUN npm install
RUN npx playwright install --with-deps chromium

# Copy the rest of the application
COPY . .

# Expose the port
EXPOSE 3000

# Start the app
CMD ["node", "server.js"]