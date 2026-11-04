# Radiola - Makefile shortcuts. All the work is done by build.sh;
# these targets exist for people used to `make`, for CI and for releases.

.PHONY: all pack install uninstall enable disable prefs status pot check release clean

all: pack

pack:
	./build.sh build

install:
	./build.sh install

uninstall:
	./build.sh uninstall

enable:
	./build.sh enable

disable:
	./build.sh disable

prefs:
	./build.sh prefs

status:
	./build.sh status

pot:
	./build.sh pot

check:
	./build.sh check

clean:
	./build.sh clean

# Publish a new version: sets version-name, commits, tags vX.Y and pushes.
# GitHub Actions then builds the zip and creates the GitHub Release.
# Usage: make release VERSION=1.1
release:
	@test -n "$(VERSION)" || { echo "Usage: make release VERSION=1.1"; exit 1; }
	@test "$$(git rev-parse --abbrev-ref HEAD)" = main || { echo "Run it from the main branch"; exit 1; }
	@git diff --quiet && git diff --cached --quiet || { echo "Commit or stash your changes first"; exit 1; }
	@! git rev-parse -q --verify "refs/tags/v$(VERSION)" >/dev/null || { echo "Tag v$(VERSION) already exists"; exit 1; }
	git pull --ff-only
	sed -i 's/"version-name": "[^"]*"/"version-name": "$(VERSION)"/' metadata.json
	./build.sh build
	git diff --quiet metadata.json || git commit -m "Release $(VERSION)" metadata.json
	git tag -a "v$(VERSION)" -m "Radiola $(VERSION)"
	git push origin main "v$(VERSION)"
	@echo "Pushed v$(VERSION). GitHub Actions will publish the release."
