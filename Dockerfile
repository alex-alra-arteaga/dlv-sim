# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=23-bullseye
FROM node:${NODE_VERSION} AS base

WORKDIR /app

# Install native build dependencies for sqlite3 and patch-package
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        python3 \
        libsqlite3-dev \
        patch \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests first for efficient caching
COPY package.json yarn.lock ./
COPY patches ./patches

# Install node modules (patch-package runs during postinstall)
RUN yarn install --frozen-lockfile \
    && yarn cache clean

# Copy application source
COPY . .

ENV NODE_ENV=production

# Default command can be overridden, e.g. `docker run image yarn brute-force:light`
CMD ["yarn", "test"]
