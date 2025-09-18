#!/bin/bash

set -e

echo "🚀 Deploying Next.js Sandbox Preview Platform..."

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker and try again."
    exit 1
fi

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ .env file not found. Please create it from .env.example"
    exit 1
fi

# Create logs directory
mkdir -p logs

# Build and start the services
echo "🏗️  Building and starting services..."
docker compose down --remove-orphans
docker compose build
docker compose up -d

echo "⏳ Waiting for services to be ready..."
sleep 10

# Check service health
echo "🔍 Checking service health..."
docker compose ps

# Show API logs
echo "📄 Showing API logs (Ctrl+C to exit)..."
docker compose logs -f api

echo "✅ Deployment complete!"
echo ""
echo "🌐 Access points:"
echo "  - API: http://api.${PREVIEW_DOMAIN:-preview.example.com}"
echo "  - Traefik Dashboard: http://localhost:8080 (if exposed)"
echo "  - MinIO Console: http://minio-console.${PREVIEW_DOMAIN:-preview.example.com}"
echo ""
echo "📖 Check README.md for usage instructions."