# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NITRO_PORT=3100 \
    NITRO_HOST=0.0.0.0 \
    CAPSTACK_DB=/app/data/capstack.db
RUN apk add --no-cache tini && \
    mkdir -p /app/data && \
    chown -R node:node /app
COPY --from=build --chown=node:node /app/.output ./.output
USER node
EXPOSE 3100
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", ".output/server/index.mjs"]