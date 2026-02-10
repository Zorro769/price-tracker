# Base image with Playwright + Chromium preinstalled
FROM mcr.microsoft.com/playwright:focal

# Set working directory
WORKDIR /app

# Copy package.json / lockfiles
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all your code
COPY . .

# Optional: expose a port if needed (for web services)
# EXPOSE 3000

# Run your tracker
CMD ["node", "index.js"]