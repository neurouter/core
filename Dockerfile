# syntax=docker/dockerfile:1.7
# Neurouter image (backend spec §20.1; ADAPT Neurouter Hub). glibc base: onnxruntime-node, sqlite-vec and
# the Monty prebuilds target glibc. Multi-arch: docker buildx build --platform linux/amd64,linux/arm64 -t neurouter:dev .
ARG NODE_IMAGE=node:26.13.1-bookworm-slim

# ---------------------------------------------------------------- toolchain for native modules
FROM ${NODE_IMAGE} AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------- all dependencies (build)
FROM toolchain AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/compiler/package.json packages/compiler/
COPY packages/evals/package.json packages/evals/
COPY packages/cli/package.json packages/cli/
COPY apps/executor/package.json apps/executor/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# onnxruntime-node's install script would download the CUDA execution provider (~270 MB) on linux/x64;
# there is no GPU here. The CPU binaries ship in the npm package.
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------- build: shared → compiler → evals → executor → web → server → cli
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
RUN npx tsc -b packages/shared packages/compiler packages/evals apps/executor apps/server packages/cli \
 && node apps/server/scripts/bundle.mjs \
 && (npm run build --if-present -w @neurouter/web || (echo "console build failed; serving the API only" && mkdir -p apps/web/dist))
# pin the Monty worker binary by path + sha256 (§10.6, §18.7)
RUN node -e "import('@pydantic/monty').then(m=>{const p=(m.findMontyBinary??m.default.findMontyBinary)();console.log(p)})" > /app/monty-path \
 && sha256sum "$(cat /app/monty-path)" | cut -d' ' -f1 > /app/monty-sha256 \
 && echo "monty: $(cat /app/monty-path) $(cat /app/monty-sha256)"
ARG EMBEDDINGS_MODEL=onnx-community/granite-embedding-small-english-r2-ONNX
ARG EMBEDDINGS_DTYPE=q8
ARG BAKE_MODEL=true
RUN if [ "$BAKE_MODEL" = "true" ]; then EMBEDDINGS_MODEL=${EMBEDDINGS_MODEL} EMBEDDINGS_DTYPE=${EMBEDDINGS_DTYPE} MODELS_DIR=/app/models node apps/server/dist/scripts/fetch-model.js; else mkdir -p /app/models; fi

# ---------------------------------------------------------------- production dependencies of the server (+ its workspace packages)
FROM toolchain AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/compiler/package.json packages/compiler/
COPY packages/evals/package.json packages/evals/
COPY packages/cli/package.json packages/cli/
COPY apps/executor/package.json apps/executor/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
ENV ONNXRUNTIME_NODE_INSTALL=skip
# image slimming: keep only this platform's onnxruntime binaries (the package ships darwin, win32 and
# linux arm64/x64), and drop onnxruntime-web: @huggingface/transformers' Node build inlines what it
# uses of it and loads onnxruntime-node for inference
RUN npm ci --omit=dev --no-audit --no-fund --workspace @neurouter/server --workspace neurouter --include-workspace-root=false \
 && cd node_modules/onnxruntime-node/bin/napi-v6 \
 && find . -mindepth 1 -maxdepth 2 ! -path ./linux ! -path "./linux/$(node -p process.arch)" -exec rm -rf {} + \
 && test -f "linux/$(node -p process.arch)/onnxruntime_binding.node" \
 && rm -rf /app/node_modules/onnxruntime-web \
 && cd /app && mkdir -p apps/server/node_modules apps/executor/node_modules packages/shared/node_modules packages/compiler/node_modules packages/evals/node_modules packages/cli/node_modules

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
ARG EMBEDDINGS_MODEL=onnx-community/granite-embedding-small-english-r2-ONNX
ARG EMBEDDINGS_DTYPE=q8
ENV NODE_ENV=production \
    PORT=3000 \
    MODELS_DIR=/app/models \
    EMBEDDINGS_MODEL=${EMBEDDINGS_MODEL} \
    EMBEDDINGS_DTYPE=${EMBEDDINGS_DTYPE} \
    EMBEDDINGS_ALLOW_REMOTE=false \
    WEB_DIST_DIR=/app/apps/web/dist \
    SERVE_WEB=true \
    DATABASE_URL=sqlite:/data/neurouter.db \
    NEUROUTER_EXECUTOR_MODE=embedded \
    NEUROUTER_EXECUTOR_SOCKET=/tmp/neurouter-executor.sock \
    NODE_COMPILE_CACHE=/app/.node-compile-cache
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps --chown=node:node /app/apps/executor/node_modules ./apps/executor/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/compiler/node_modules ./packages/compiler/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/evals/node_modules ./packages/evals/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/cli/node_modules ./packages/cli/node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/packages/compiler/package.json ./packages/compiler/package.json
COPY --from=build --chown=node:node /app/packages/compiler/dist ./packages/compiler/dist
COPY --from=build --chown=node:node /app/packages/evals/package.json ./packages/evals/package.json
COPY --from=build --chown=node:node /app/packages/evals/dist ./packages/evals/dist
COPY --from=build --chown=node:node /app/packages/cli/package.json ./packages/cli/package.json
COPY --from=build --chown=node:node /app/packages/cli/dist ./packages/cli/dist
COPY --from=build --chown=node:node /app/apps/executor/package.json ./apps/executor/package.json
COPY --from=build --chown=node:node /app/apps/executor/dist ./apps/executor/dist
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/server/dist-bundle ./apps/server/dist-bundle
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/models ./models
COPY --from=build --chown=node:node /app/monty-path /app/monty-sha256 ./
COPY --chown=node:node examples ./examples
COPY --chown=node:node neurouter.example.yaml ./neurouter.example.yaml
# no COPY --chmod: Cloud Build's default `docker build` is the legacy builder (BuildKit-only flag)
COPY --chown=node:node deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh && mkdir -p /data /app/.node-compile-cache && chown node:node /data /app/.node-compile-cache
USER node
# V8 compile cache for the production bundle (cold start): compiles what the server process, the
# executor child (Monty) and the embedding worker (transformers.js) load at boot, without starting the
# server. Same user, paths and Node binary as at runtime, so the cache is accepted.
RUN node --max-semi-space-size=16 --import ./apps/server/dist/instrumentation.js --input-type=module \
      -e "await import('./apps/server/dist-bundle/server.js'); for (const m of ['@pydantic/monty', '@huggingface/transformers']) await import(m).catch((e) => console.log('compile cache: skipped', m, e.message))" \
 && (node apps/server/dist-bundle/executor/main.js 2>/dev/null; true) \
 && echo "compile cache: $(find /app/.node-compile-cache -type f | wc -l) entries, $(du -sh /app/.node-compile-cache | cut -f1)"
EXPOSE 3000
VOLUME ["/data"]
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Neurouter" \
      org.opencontainers.image.description="Turn an OpenAPI or GraphQL API into a governed MCP server with code mode, ops tools and evals." \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/neurouter/core" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
# the production bundle (apps/server/scripts/bundle.mjs); dist/ stays for the CLI, migrations and instrumentation
CMD ["node", "--max-semi-space-size=16", "--import", "./apps/server/dist/instrumentation.js", "apps/server/dist-bundle/main.js"]
