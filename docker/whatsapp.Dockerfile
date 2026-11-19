# People's linked WhatsApp accounts (whatsapp/server.ts). Only Emplio talks to it, with WHATSAPP_TOKEN.
FROM node:22-slim
WORKDIR /app
COPY whatsapp/package.json whatsapp/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY whatsapp/*.ts ./
ENV DATA_DIR=/data NODE_ENV=production
CMD ["node", "--disable-warning=ExperimentalWarning", "server.ts"]
