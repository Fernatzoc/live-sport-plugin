FROM node:22-alpine

WORKDIR /app

# Copy package files and install all dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the bundled output in dist/
RUN npm run build

# Set default port
ENV PORT=7000
EXPOSE 7000

# Start the application
CMD ["npm", "start"]
