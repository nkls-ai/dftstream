FROM ghcr.io/get-convex/convex-backend:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL=/root/.bun
ENV PATH="$BUN_INSTALL/bin:$PATH"

WORKDIR /app/db
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY convex/ ./convex/

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV CONVEX_PORT=16767
ENV CONVEX_SITE_PORT=16768
ENV CONVEX_INSTANCE_NAME=dftstream

EXPOSE 16767 16768

VOLUME ["/convex/data"]

ENTRYPOINT ["/entrypoint.sh"]
