.PHONY: build install update-cli test vet race ui-build ui-clean version

# Version stamps injected at link time. `make build` from a working
# tree picks up the local git state; CI / goreleaser overrides these
# with the tag.
VERSION ?= $(shell git -C .. describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git -C .. rev-parse --short=12 HEAD 2>/dev/null || echo unknown)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

LDFLAGS := \
  -s -w \
  -X github.com/nkls-ai/dftstream/internal/version.Version=$(VERSION) \
  -X github.com/nkls-ai/dftstream/internal/version.Commit=$(COMMIT) \
  -X github.com/nkls-ai/dftstream/internal/version.Date=$(DATE)

# `make build` produces ./bin/dftstream with the embedded UI bundle
# and a stamped version.
build: ui-build
	mkdir -p bin
	go build -trimpath -ldflags '$(LDFLAGS)' -o bin/dftstream ./cmd/dftstream

# `make install` puts the same binary into $(GOBIN) or ~/go/bin.
install: ui-build
	go install -trimpath -ldflags '$(LDFLAGS)' ./cmd/dftstream

update-cli:
	git -C .. pull --ff-only
	$(MAKE) install

test:
	go test ./...

vet:
	go vet ./...

race:
	go test -race ./...

version:
	@echo "version: $(VERSION)"
	@echo "commit:  $(COMMIT)"
	@echo "date:    $(DATE)"

# ui-build (re)builds the UI bundle and copies it into the package
# that go:embeds it. The embed directive in uiserver.go REQUIRES
# dist/index.html, so this target must run before any `go build` of
# the dftstream command — `make build`/`make install` enforce that.
ui-build:
	@command -v bun >/dev/null 2>&1 || { \
	  printf 'error: bun is required to build the UI bundle.\n' >&2; \
	  printf 'fix: install bun (https://bun.sh) and rerun.\n' >&2; \
	  exit 2; \
	}
	# Both workspaces — the UI bundle imports @db/api which
	# transitively pulls in convex/server from db/node_modules.
	cd ../ui && bun install --silent
	cd ../db && bun install --silent
	cd ../ui && bun run build
	mkdir -p internal/uiserver/dist
	find internal/uiserver/dist -mindepth 1 -delete
	# Exclude source maps — they bloat the embedded binary by ~10 MB
	# and aren't needed in a shipped artifact.
	cd ../ui/dist && find . -type f ! -name '*.map' -print0 \
	  | xargs -0 -I{} cp --parents {} ../../wrapper/internal/uiserver/dist/

ui-clean:
	rm -rf internal/uiserver/dist
	mkdir -p internal/uiserver/dist
