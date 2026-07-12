FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# Copies server.js plus the widget copy bundled next to it (see deploy notes).
COPY . .

EXPOSE 8787
CMD ["node", "server.js"]
