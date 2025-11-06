# Local E2E Testing Guide

## Quick Start

Run the complete e2e test suite locally:

```bash
cd e2e
npm run test:local
```

## Step-by-Step Testing

### 1. Setup Test Containers
```bash
cd e2e
npm run test:setup
```
This will:
- Pull required Docker images (nginx, homeassistant, traefik)
- Tag images to simulate different registries
- Start 10 test containers with proper labels

### 2. Start WUD
```bash
npm run test:start-wud
```
This will:
- Build WUD Docker image
- Start WUD container with test configuration
- Wait 20 seconds for WUD to fetch updates

### 3. Run Tests
```bash
npm run cucumber
```

### 4. Cleanup
```bash
npm run test:cleanup
```

## Environment Variables

For full functionality, set these environment variables:

```bash
export AWS_ACCESSKEY_ID="your-aws-key"
export AWS_SECRET_ACCESSKEY="your-aws-secret"
export GITHUB_USERNAME="your-github-username"
export GITHUB_TOKEN="your-github-token"
export GITLAB_TOKEN="your-gitlab-token"
```

## Manual Scripts

All scripts are in the `scripts/` directory:

- `setup-test-containers.sh` - Pull images and start test containers
- `start-wud.sh` - Build and start WUD container
- `cleanup-test-containers.sh` - Remove all test containers
- `run-e2e-tests.sh` - Complete test suite

## Test Containers

The setup creates 10 containers matching the optimized test cases:

| Registry | Container | Image | Purpose |
|----------|-----------|-------|---------|
| ECR | ecr_sub_sub_test | ECR test image | Semver major update |
| GHCR | ghcr_radarr | linuxserver/radarr | Complex semver update |
| GitLab | gitlab_test | docker-registry-test | Semver major update |
| Quay | quay_prometheus | prometheus/prometheus | Semver major update |
| Hub | hub_homeassistant_202161 | home-assistant:2021.6.1 | Date-based versioning |
| Hub | hub_homeassistant_latest | home-assistant:latest | Latest tag no update |
| Hub | hub_nginx_120 | nginx:1.20-alpine | Alpine minor update |
| Hub | hub_nginx_latest | nginx:latest | Latest tag digest update |
| Hub | hub_traefik_245 | traefik:2.4.5 | Semver major update |
| LSCR | lscr_radarr | linuxserver/radarr | Complex semver update |

## Troubleshooting

- **Port 3000 in use**: Stop any running WUD instance first
- **Docker permission denied**: Ensure your user is in the docker group
- **Registry authentication**: Set environment variables for private registries
- **Container conflicts**: Run cleanup script before starting tests