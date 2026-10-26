# Minimal dftstream image: distroless static base (includes CA
# certificates and tzdata, runs as nonroot) + the dftstream binary.
# The binary is fully static (CGO_ENABLED=0) and embeds the web UI.
#
# This Dockerfile is built by goreleaser during a release (see the
# `dockers:` section of .goreleaser.yaml), which places the prebuilt
# linux binary in the build context. It is NOT buildable from the repo
# root on its own. To build it by hand, stage a binary first:
#
#   tar -xzf dftstream_<version>_Linux_x86_64.tar.gz dftstream
#   docker build -f packaging/docker/Dockerfile -t dftstream:<version> .
#
# (run from the directory containing the extracted `dftstream` binary)
#
# Typical use — mount the working directory with the .inp files:
#
#   docker run --rm -v "$PWD":/work -w /work \
#     -e DFTSTREAM_TRACKER_URL=convex+http://host:3210 \
#     dftstream:<version> run water.inp --exp demo
#
# Note: ORCA itself is license-restricted and is NOT in this image; the
# image is useful for `dftstream ui`, queries, and reimport tooling, or
# as a base layer for a site-local image that adds ORCA.
FROM gcr.io/distroless/static-debian12:nonroot

COPY dftstream /usr/local/bin/dftstream

ENTRYPOINT ["/usr/local/bin/dftstream"]
