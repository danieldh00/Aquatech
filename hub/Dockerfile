# Bouwstap: verkleint de frontend (JS en CSS) voor de release; de broncode in
# de repo blijft leesbaar. esbuild zit alleen in deze stap, niet in het image.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS frontend-build
WORKDIR /build/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/tools/minify-frontend.js ./tools/minify-frontend.js
COPY frontend ../frontend
RUN node tools/minify-frontend.js ../frontend ../frontend-min

FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

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

# Gezondheidscontrole in het image zelf (ook zonder compose): /api/health moet antwoorden.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3300)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# De database is PostgreSQL: zonder DATABASE_URL (of DATABASE_URL_FILE) start de app niet.
CMD ["node", "src/server.js"]
