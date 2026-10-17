# The orchestrator daemon image. See deploy/README.md.
# It carries Node, git, and ssh only: project toolchains belong to the worker and verifier images.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/orchestrator
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# npm ci leaves empty scope directories behind for omitted devDependencies; drop them.
RUN npm ci --omit=dev --ignore-scripts \
  && find node_modules -mindepth 1 -maxdepth 1 -type d -empty -delete \
  && npm cache clean --force
COPY --from=build /app/dist/src ./dist/src
RUN chmod +x dist/src/main.js dist/src/operator/cli.js \
  && ln -s /opt/orchestrator/dist/src/main.js /usr/local/bin/orchestrator \
  && ln -s /opt/orchestrator/dist/src/operator/cli.js /usr/local/bin/orchestrator-ctl
USER node
CMD ["orchestrator"]
