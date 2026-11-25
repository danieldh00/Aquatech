# Bouwstap: verkleint de frontend (JS en CSS) voor de release; de broncode in
# de repo blijft leesbaar. esbuild zit alleen in deze stap, niet in het image.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS frontend-build
WORKDIR /build/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/tools/minify-frontend.js ./tools/minify-frontend.js
COPY frontend ../frontend
RUN node tools/minify-frontend.js ../frontend ../frontend-min
# Vue-modules (alleen staging): kommagescheiden lijst, bijvoorbeeld "klanten", of "alle" voor elke module in hub/frontend-vue. Leeg (productie) = niets extra's, het
# image blijft gelijk en npm wordt voor de modules niet eens aangeroepen. Met een lijst bouwt Vite hub/frontend-vue; de
# pagina van elke genoemde module vervangt de oude pagina in de frontend, de gedeelde bestanden komen in assets/ ernaast.
# De schil (zijbalk, rekeningmenu) wordt niet gebouwd: de pagina's verwijzen naar de verkleinde bestanden in shared/.
ARG VUE_MODULES=""
COPY frontend-vue ../frontend-vue
RUN if [ -n "$VUE_MODULES" ]; then \
      set -e; \
      cd ../frontend-vue && npm ci && npm run build; \
      if [ "$VUE_MODULES" = "alle" ]; then modules=$(ls dist | grep -vx assets); else modules=$(echo "$VUE_MODULES" | tr ',' ' '); fi; \
      for module in $modules; do \
        [ -f "dist/$module/index.html" ] || { echo "FOUT: Vue-module '$module' bestaat niet in hub/frontend-vue/src/modules." >&2; exit 1; }; \
        rm -rf "../frontend-min/$module"; \
        cp -r "dist/$module" "../frontend-min/$module"; \
      done; \
      cp -r dist/assets ../frontend-min/assets; \
    fi

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
