#!/usr/bin/env bash
# Regenerates src/proto from the namespacelabs/internal repository.
#
# Usage:
#   npm run generate                       # expects ../internal checkout
#   NS_INTERNAL=/path/to/internal npm run generate
#
# Generates from the working tree of the internal checkout. Make sure it is
# up to date (e.g. `git fetch && git checkout origin/main`) before running.
set -euo pipefail

cd "$(dirname "$0")/.."

INTERNAL="${NS_INTERNAL:-../internal}"
if [[ ! -d "$INTERNAL/public/proto" ]]; then
	echo "error: internal checkout not found at $INTERNAL (set NS_INTERNAL)" >&2
	exit 1
fi

# The Bazel integration protos import Bazel's own protos, which are not
# vendored in internal/public; exclude them (same as internal's web codegen).
exec npx buf generate "$INTERNAL/public" \
	--exclude-path "$INTERNAL/public/proto/namespace/cloud/integrations/bazel/v1beta"
