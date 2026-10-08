# Build context: the repository root (see ../bench).
# Base images are pinned by digest so every machine builds the same CLI.
ARG NODE_IMAGE=node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ARG DOCKER_CLI_IMAGE=docker:29.4.3-cli@sha256:51e23845f5caff1e688a2fae003b0c69d635c9200ad544731db1593731df1d3a

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM ${NODE_IMAGE} AS deps
WORKDIR /opt/dexter-bench-lab/cli
COPY cli/package.json cli/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY cli/tsconfig.json ./
COPY cli/src ./src
RUN npx tsc -p tsconfig.json

FROM build AS test
COPY cli/vitest.config.ts ./
COPY cli/test ./test
RUN npx vitest run --passWithNoTests

FROM ${NODE_IMAGE} AS runtime
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
WORKDIR /opt/dexter-bench-lab/cli
COPY cli/package.json cli/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /opt/dexter-bench-lab/cli/dist ./dist
ENV BENCH_KIT_DIR=/opt/dexter-bench-lab
ENTRYPOINT ["node", "/opt/dexter-bench-lab/cli/dist/main.js"]
