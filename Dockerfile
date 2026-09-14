FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY packages/contracts packages/contracts
COPY apps/control-plane apps/control-plane
RUN npm run build:contracts && npm run build:control-plane
RUN npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
CMD ["npm", "run", "start", "--workspace", "@ahm/control-plane"]
