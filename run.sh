#!/usr/bin/env bash
# One command to get running. npm scripts are the real interface; this is here
# for people who would rather type ./run.sh.
set -euo pipefail

cmd="${1:-replay}"

if [ ! -d node_modules ]; then
  echo "installing dependencies..."
  npm install --no-audit --no-fund
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "created .env from .env.example (LLM_PROVIDER=fake, DRY_RUN=true)"
fi

case "$cmd" in
  replay)   npm run replay:demo ;;
  silence)  npm run replay:silence ;;
  meet)     npm run replay:meet ;;
  slack)    npm run dev:dry ;;
  live)     npm run dev ;;
  check)    npm run ci ;;
  *)
    cat <<USAGE
usage: ./run.sh [command]

  replay    the demo conversation, no Slack, no key          (default)
  silence   a conversation the agent should ignore entirely
  meet      the stage 2 surface: a live meeting transcript
  slack     live Slack, decides but never posts
  live      live Slack, actually posts
  check     everything CI runs
USAGE
    exit 1 ;;
esac
