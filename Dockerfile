FROM node:18-slim

# Install git
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Create directories for data, cache, and repos
RUN mkdir -p data cache repos

# Expose port if needed for HTTP transport
# EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV CACHE_DIR=/app/cache
ENV REPOS_DIR=/app/repos

# Run the server
CMD ["npm", "start"]
