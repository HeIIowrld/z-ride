# node:sqlite is available without a flag from Node 22.13 onward.
# Pin a tested digest before a public release.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000 \
    ZRIDE_DB_PATH=/data/zride.sqlite
WORKDIR /app

COPY --chown=node:node server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node server/*.mjs ./
COPY --chown=node:node server/observer/ ./observer/
COPY --chown=node:node server/phone-client/ ./phone-client/
COPY --chown=node:node minigames/style.css ./drive-assets/
COPY --chown=node:node minigames/games/ ./drive-assets/games/
COPY --chown=node:node minigames/shared/ ./drive-assets/shared/
COPY --chown=node:node minigames/data/*.json ./drive-assets/data/
RUN mkdir -p /data && chown node:node /data && chmod 700 /data

USER node
EXPOSE 8000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD ["node", "--input-type=module", "-e", "try { const r = await fetch('http://127.0.0.1:8000/healthz', { signal: AbortSignal.timeout(3000) }); const body = await r.json(); process.exit(r.ok && body.ok === true && body.protocol === 'zride-demo-v1' && body.contractRevision >= 3 ? 0 : 1); } catch { process.exit(1); }"]
CMD ["node", "server.mjs"]
