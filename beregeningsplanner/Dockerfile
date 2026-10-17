FROM node:22-alpine

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend ./
COPY frontend ../frontend
COPY config.yaml ../config.yaml

ENV PORT=3300
ENV NODE_ENV=production
EXPOSE 3300

# Supervisor geeft deze mee bij het bouwen van de add-on; onschadelijk
# (leeg) bij een gewone `docker build`.
ARG BUILD_VERSION
ARG BUILD_ARCH
LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}"

CMD ["node", "src/server.js"]
