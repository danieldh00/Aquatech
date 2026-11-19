# Bouwstap: verkleint de frontend (JS en CSS) voor de release; de broncode in
# de repo blijft leesbaar. esbuild zit alleen in deze stap, niet in het image.
FROM node:22-alpine AS frontend-build
WORKDIR /build/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/tools/minify-frontend.js ./tools/minify-frontend.js
COPY frontend ../frontend
RUN node tools/minify-frontend.js ../frontend ../frontend-min

FROM node:22-alpine

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend ./
COPY --from=frontend-build /build/frontend-min ../frontend

ENV PORT=3300
ENV NODE_ENV=production
EXPOSE 3300
ENV DATA_DIR=/data
VOLUME /data

# node:sqlite (de database) meldt in Node 22 nog een ExperimentalWarning.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
