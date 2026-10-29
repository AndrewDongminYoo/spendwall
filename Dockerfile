FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.24.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
COPY apps/firewall/package.json apps/firewall/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/agent-demo/package.json apps/agent-demo/package.json
COPY packages/policy/package.json packages/policy/package.json
RUN pnpm install --frozen-lockfile
COPY apps/firewall/src apps/firewall/src
COPY apps/dashboard apps/dashboard
COPY packages/policy/src packages/policy/src
COPY scripts/hosted-dashboard.mjs scripts/hosted-dashboard.mjs
COPY scripts/dashboard.mjs scripts/dashboard.mjs
COPY scripts/check-paypal-sandbox.mjs scripts/check-paypal-sandbox.mjs
COPY tsconfig.base.json ./
RUN pnpm --filter @spendwall/dashboard build

FROM node:24.22.2-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=12s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const req = require('node:http').get({ hostname: '127.0.0.1', port: process.env.PORT, path: '/healthz', headers: { host: new URL(process.env.SPENDWALL_PUBLIC_ORIGIN).host }, timeout: 10000 }, res => process.exit(res.statusCode === 200 ? 0 : 1)); req.on('timeout', () => req.destroy()); req.on('error', () => process.exit(1));"]
CMD ["node", "scripts/hosted-dashboard.mjs"]
