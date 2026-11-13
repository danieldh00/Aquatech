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

# node:sqlite (de database) meldt in Node 22 nog een ExperimentalWarning.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
