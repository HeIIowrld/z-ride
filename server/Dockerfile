# Existing demo runtime baseline. Pin a tested digest before a public release.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000
WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node server.mjs world.mjs ./

USER node
EXPOSE 8000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD ["node", "--input-type=module", "-e", "try { const r = await fetch('http://127.0.0.1:8000/healthz', { signal: AbortSignal.timeout(3000) }); const body = await r.json(); process.exit(r.ok && body.ok === true && body.contractRevision === 3 ? 0 : 1); } catch { process.exit(1); }"]
CMD ["node", "server.mjs"]
