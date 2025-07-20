ARG NODE_VERSION=20

FROM node:${NODE_VERSION} AS builder
WORKDIR /usr/src/app

COPY package*.json ./
RUN --mount=type=cache,target=/usr/src/app/.npm \
    npm set cache /usr/src/app/.npm && npm install

COPY . .

FROM node:${NODE_VERSION} AS runner
WORKDIR /usr/src/app

COPY --from=builder /usr/src/app .

EXPOSE 3000
CMD ["node", "src/index.js"]
