#!/bin/bash

echo "📊 Next.js Sandbox Preview Platform Status"
echo "=========================================="

# Check Docker
if ! docker info >/dev/null 2>&1; then
    echo "❌ Docker is not running"
    exit 1
else
    echo "✅ Docker is running"
fi

# Check Docker Compose services
echo ""
echo "🏗️  Services Status:"
docker compose ps

echo ""
echo "📈 Resource Usage:"
echo "CPU: $(docker stats --no-stream --format "{{.CPUPerc}}" --filter "name=api" | head -1) (API)"
echo "Memory: $(docker stats --no-stream --format "{{.MemUsage}}" --filter "name=api" | head -1) (API)"

echo ""
echo "🔄 Queue Status (if available):"
if docker compose ps redis | grep -q "running"; then
    docker compose exec redis redis-cli info replication | grep -E "(connected_clients|total_connections_received)"
else
    echo "❌ Redis is not running"
fi

echo ""
echo "🌐 Network Info:"
echo "Preview Domain: ${PREVIEW_DOMAIN:-preview.example.com}"
echo "API URL: http://api.${PREVIEW_DOMAIN:-preview.example.com}"

echo ""
echo "🚀 Active Sandboxes:"
docker ps --filter "label=sandbox=true" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | head -10

echo ""
echo "📊 Disk Usage:"
docker system df --format "table {{.Type}}\t{{.TotalSize}}\t{{.Reclaimable}}"