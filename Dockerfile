# Small, single-process image. The game is static files plus one Node server
# that also serves the WebSocket, so there is nothing to build.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Hosts set PORT; the server already reads it and binds 0.0.0.0.
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "server/server.js"]
