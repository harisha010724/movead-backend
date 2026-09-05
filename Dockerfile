# One image, three start commands (architecture Part 2.1). The api, ingestion
# and worker tasks differ only in the command ECS gives them, so they can never
# drift to different builds of the same code.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only: no tsx, no vitest, no eslint in the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY openapi ./openapi
# Migrations are plain JS and run from the image as a pre-deploy task.
COPY src/db/migrations ./src/db/migrations
COPY src/db/config.js ./src/db/config.js
COPY .sequelizerc ./.sequelizerc

USER node
EXPOSE 8080 8081

# Overridden per service: start:api | start:ingestion | start:worker
CMD ["node", "dist/entrypoints/api.js"]
