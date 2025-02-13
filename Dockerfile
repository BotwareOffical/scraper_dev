FROM node:18


WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application
COPY . .

# Install Playwright browsers
RUN npx playwright install

# Install dependencies for Playwright
RUN apt-get update && apt-get install -y \
    libgtk-4-0 \
    libgraphene-1.0-0 \
    libgstreamer-gl1.0-0 \
    libgstreamer-plugins-bad1.0-0 \
    libavif13 \
    libenchant-2-2 \
    libsecret-1-0 \
    libmanette-0.2-0 \
    libgles2 \
    && rm -rf /var/lib/apt/lists/*

# Expose the port your app runs on
EXPOSE 10000a

# Start the application
CMD ["node", "app.js"]
