FROM node:22-alpine

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend ./
COPY frontend ../frontend

ENV PORT=3300
ENV NODE_ENV=production
EXPOSE 3300
ENV DATA_DIR=/data
VOLUME /data

# De database is PostgreSQL: zonder DATABASE_URL (of DATABASE_URL_FILE) start de app niet.
CMD ["node", "src/server.js"]
