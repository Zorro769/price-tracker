# Use the latest Playwright image (or match your package.json version)
FROM mcr.microsoft.com/playwright:v1.58.2-focal

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy app code
COPY . .

# Run your tracker
CMD ["node", "index.js"]
