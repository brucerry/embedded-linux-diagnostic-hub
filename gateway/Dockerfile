FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --omit=optional
COPY gateway ./gateway
COPY backend ./backend
COPY shared ./shared
RUN npx esbuild gateway/main.ts --bundle --platform=node --format=cjs --outfile=dist-gateway/main.cjs --external:ssh2

FROM node:24-bookworm-slim
ENV NODE_ENV=production HUB_GATEWAY_HOST=0.0.0.0
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts
COPY --from=build /app/dist-gateway ./dist-gateway
USER node
EXPOSE 8787
CMD ["node", "dist-gateway/main.cjs"]
