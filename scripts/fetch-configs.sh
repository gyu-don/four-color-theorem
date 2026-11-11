#!/usr/bin/env bash
# reducible-configurations を vendor/ に取得する(既にあれば何もしない)
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=vendor/reducible-configurations
if [ -d "$DEST/D" ]; then
  echo "既に存在します: $DEST"
  exit 0
fi
mkdir -p vendor
git clone --depth 1 https://github.com/near-linear-4ct/reducible-configurations.git "$DEST"
