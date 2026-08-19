#!/bin/bash
# Pre-bundled start for memory-constrained hosts (Alwaysdata etc.)
# The main app is fully bundled in dist/index.js (no npm install needed).
# The resolver needs its few small deps installed individually to avoid OOM.
echo "Nuvio Live Sports Plugin — zero-install launcher"

# Install resolver deps one-at-a-time (tiny packages, won't OOM)
for pkg in big-integer happy-dom; do
  if [ ! -d "node_modules/$pkg" ]; then
    echo "Installing resolver dependency: $pkg..."
    npm install --no-save --no-audit --no-fund --loglevel=error "$pkg" 2>/dev/null
  fi
done

# Force V8 to garbage collect before hitting Alwaysdata's ~100MB OS limit and use sequential fetching
LOW_MEMORY_MODE=true NODE_OPTIONS="--max-old-space-size=70" node dist/index.js
