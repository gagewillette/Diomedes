# ---- build the React client ----
FROM node:22-alpine AS client
WORKDIR /build
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ---- install server production deps ----
FROM node:22-alpine AS server-deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:22-alpine
ENV NODE_ENV=production
# LibreOffice Impress converts uploaded PPTX documents to PDF (see
# server/src/lib/convert.js). libreoffice-writer is not optional here: with
# impress alone every conversion dies with a UNO RuntimeException on Alpine.
# The font packages keep converted slides from falling back to tofu.
# Note `soffice --version` crashes on Alpine even when conversion works fine,
# so it is no use as a smoke test — check the binary is on PATH instead.
RUN apk add --no-cache \
      libreoffice-impress libreoffice-writer \
      ttf-dejavu font-noto font-noto-cjk \
  && command -v soffice
ENV SOFFICE_PATH=/usr/bin/soffice
WORKDIR /app
COPY --from=server-deps /app/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY --from=client /build/dist ./public
EXPOSE 3000
CMD ["node", "src/index.js"]
