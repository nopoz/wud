# Set by BuildKit; declared so a builder without it can pass a value.
ARG BUILDPLATFORM

# Common Stage
FROM node:22-alpine as base

LABEL maintainer="nopoz"
EXPOSE 3000

ARG HOSAKA_VERSION=unknown

ENV WORKDIR=/home/node/app
ENV HOSAKA_LOG_FORMAT=text
ENV HOSAKA_VERSION=$HOSAKA_VERSION

WORKDIR /home/node/app

RUN mkdir /store

RUN apk update \
    # patch OS-level packages (busybox, openssl, ...) to the latest in the branch
    && apk upgrade --no-cache \
    # add tzdata and openssl dependencies
    && apk add --no-cache tzdata openssl \
    # add common programs used in shell scripting
    && apk add --no-cache bash curl jq \
    && rm -rf /var/cache/apk/*

# Dependencies Stage (Backend)
# Not FROM base: Node under QEMU dies with SIGILL on the arm64 leg, and the
# tree has no native modules, so install on the build host instead.
FROM --platform=$BUILDPLATFORM node:22-alpine as dependencies

WORKDIR /home/node/app

# Copy backend package files
COPY app/package*.json ./

# Install backend dependencies. --ignore-scripts blocks dependency lifecycle
# hooks (the npm supply-chain worm execution vector); no runtime dep needs them.
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --no-update-notifier

# Frontend Build Stage
FROM --platform=$BUILDPLATFORM node:22-alpine as ui-builder

# Set working directory to UI folder
WORKDIR /home/node/ui

# Copy UI package files
COPY ui/package*.json ./

# Install UI dependencies from the lockfile (npm ci, not install, so the shipped
# build is pinned), with dependency lifecycle hooks blocked.
RUN npm ci --ignore-scripts --no-audit --no-fund --no-update-notifier

# Copy all UI source files
COPY ui/ ./

# Build the UI
RUN npm run build

# Release Stage
FROM base as release

# npm is a build-time tool only; the runtime entrypoint is `node index`. Remove it
# from the released image to drop its vulnerable bundled dependencies (tar, glob,
# minimatch, cross-spawn, ...) from the attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/bin/npm \
    /usr/local/bin/npx

# Default entrypoint
COPY Docker.entrypoint.sh /usr/bin/entrypoint.sh
RUN chmod +x /usr/bin/entrypoint.sh
ENTRYPOINT ["/usr/bin/entrypoint.sh"]
CMD ["node", "index"]

# Copy backend dependencies
COPY --from=dependencies /home/node/app/node_modules ./node_modules

# Copy backend app files
COPY app/ ./

# Copy bundled scripts (e.g. the Portainer stack-update script) to /scripts
COPY scripts/ /scripts/
RUN chmod +x /scripts/portainer_stack_update.sh

# Copy built UI from the ui-builder stage
COPY --from=ui-builder /home/node/ui/dist ./ui
