# The heart-rate bridge.
#
# Read this before reaching for it: a container is the WRONG place to run this
# against a real strap. Bluetooth Low Energy needs the host's radio, which
# Docker Desktop on macOS and Windows does not pass through at all, and which on
# Linux needs the host network namespace plus D-Bus and CAP_NET_ADMIN. On your
# own machine, run it directly:
#
#     cd hr-bridge && npm install && npm start
#
# This image exists for the two cases where a container is right: the simulated
# demo (`docker compose --profile sim up`, no radio involved), and a Linux host
# running it with --network host.
FROM node:22-alpine
WORKDIR /app

# noble is optional in package.json and is the only native dependency here, so
# --omit=optional keeps this image small and buildable on any architecture. The
# simulator and every HTTP endpoint work without it; only a real BLE strap does
# not. Drop the flag (and add build-base python3 eudev-dev) for a Linux host
# build that needs the radio.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --omit=optional 2>/dev/null || npm install --omit=dev --omit=optional

COPY src ./src
COPY bin ./bin
COPY public ./public

ENV PORT=3001
ENV HOST=0.0.0.0
EXPOSE 3001
CMD ["node", "src/index.js"]
