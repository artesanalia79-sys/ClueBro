# Thin wrappers. npm scripts are the source of truth; `make` exists because
# half of any team types `make` on reflex.
.PHONY: dev replay silence meet slack check clock install fmt

install:
	npm install --no-audit --no-fund

dev: replay

replay:
	npm run replay:demo

silence:
	npm run replay:silence

meet:
	npm run replay:meet

slack:
	npm run dev:dry

check:
	npm run ci

clock:
	npm run clock

fmt:
	npm run fmt
