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
# Alleen wat de server draait: broncode en het hulpscript dat update.sh uit het image haalt.
# Tests en andere tools (codestijl, bench, minify) blijven buiten het image.
COPY backend/src ./src
COPY backend/tools/release-info.js ./tools/release-info.js
COPY --from=frontend-build /build/frontend-min ../frontend

ENV PORT=3300
ENV NODE_ENV=production
EXPOSE 3300
ENV DATA_DIR=/data
VOLUME /data

# De database is PostgreSQL: zonder DATABASE_URL (of DATABASE_URL_FILE) start de app niet.
CMD ["node", "src/server.js"]
