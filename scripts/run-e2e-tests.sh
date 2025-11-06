#!/bin/bash

set -e

echo "🧪 Running complete e2e test suite..."

# Cleanup any existing containers
./scripts/cleanup-test-containers.sh

# Setup test containers
./scripts/setup-test-containers.sh

# Start WUD
./scripts/start-wud.sh

# Run e2e tests
echo "🏃 Running cucumber tests..."
(cd e2e && npm run cucumber)

echo "✅ E2E tests completed!"