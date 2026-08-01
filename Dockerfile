# Use a lightweight Node.js image
FROM node:22-slim

# Create and set the working directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
# We use npm install instead of ci to be safe if package-lock is out of sync
RUN npm install --production

# Copy the rest of the application source code
COPY . .

# Hugging Face Spaces strictly requires apps to run on port 7860
ENV PORT=7860
EXPOSE 7860

# Start the web server
CMD [ "npm", "start" ]
