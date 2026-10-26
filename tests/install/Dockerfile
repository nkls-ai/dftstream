# Fresh Linux environment for exercising scripts/install.sh end-to-end.
# Pre-installs the minimum set of system tools the installer expects to
# find on PATH (curl, git, tar, unzip) plus Go for the source build
# path. Bun is installed by the install script itself (via --install-bun)
# so that this image stays close to a real user's first-run experience.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git tar unzip xz-utils \
      build-essential file procps \
 && rm -rf /var/lib/apt/lists/*

# Go is required because the install script's --method source path runs
# `go install ./cmd/dftstream` to build the wrapper binary. We pull a
# pinned release to keep the test reproducible.
ARG GO_VERSION=1.26.3
RUN ARCH="$(dpkg --print-architecture)" \
 && case "$ARCH" in \
      amd64) GO_ARCH=amd64 ;; \
      arm64) GO_ARCH=arm64 ;; \
      *) echo "unsupported arch: $ARCH" >&2; exit 2 ;; \
    esac \
 && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${GO_ARCH}.tar.gz" \
      | tar -C /usr/local -xz

# Run as an unprivileged user so the install script exercises the same
# code paths a regular user would hit (XDG paths under $HOME, no sudo).
RUN useradd -m -s /bin/bash tester
USER tester
WORKDIR /home/tester

ENV PATH=/usr/local/go/bin:/home/tester/.bun/bin:/home/tester/.local/bin:$PATH

# tests/install/test.sh is read out of the bind-mounted /workspace at
# runtime so changes to the test script don't require an image rebuild.
CMD ["bash", "/workspace/tests/install/test.sh"]
