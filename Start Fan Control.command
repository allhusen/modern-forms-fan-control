#!/bin/zsh
set -eu
cd -- "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
if ! command -v node >/dev/null; then
  print 'Node.js 22 or newer is required.'
  read '?Press Return to close.'
  exit 1
fi
node scripts/service.mjs start --open || { read '?Press Return to close.'; exit 1; }
