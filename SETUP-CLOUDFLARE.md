# Cloudflare Setup Guide for baytlabs.com

## 🌐 Why Cloudflare Proxy?

For `baytlabs.com`, **Cloudflare Proxy** (not tunnel) is recommended because:
- **Performance**: CDN caching and compression
- **Free SSL**: Automatic wildcard certificate management
- **Security**: DDoS protection and Web Application Firewall
- **Bandwidth**: Reduced bandwidth costs
- **Global**: Better performance worldwide
- **Simplicity**: Easy DNS management

---

## 🔧 Cloudflare Configuration

### 1. DNS Setup

In your Cloudflare dashboard:

1. Go to **DNS** → **Records**
2. Add these records for `baytlabs.com`:

   **Type**: `A`
   **Name**: `*` (wildcard for entire domain)
   **Content**: `Your server IP`
   **Proxy status**: 🟠 **Proxied (orange cloud)**
   **TTL**: Auto

   **Type**: `A`
   **Name**: `@` (root domain)
   **Content**: `Your server IP`
   **Proxy status**: 🟠 **Proxied (orange cloud)**
   **TTL**: Auto

### 2. SSL/TLS Settings

Go to **SSL/TLS** → **Overview**:
- Select **Full (strict)** mode
- This ensures end-to-end encryption

### 3. Page Rules (Optional but Recommended)

Go to **Rules** → **Page Rules**:

1. **MinIO Console Access**:
   ```
   URL: minio-console.baytlabs.com/*
   Setting: Always Use HTTPS
   ```

2. **API Caching**:
   ```
   URL: api.baytlabs.com/*
   Setting: Cache Level: Bypass
   ```

### 4. Workers/Settings (Optional)

Go to **Workers Routes** for better API routing:

```
Route: api.baytlabs.com/*
Zone: baytlabs.com
```

---

## 🚀 Server Configuration

Your `.env` is already configured:

```bash
PREVIEW_DOMAIN=preview.baytlabs.com
```

### Docker Compose Updates

The Docker Compose has been optimized for Cloudflare:
- SSL termination handled by Cloudflare
- TLS enabled for internal services
- No need for Let's Encrypt certificates

---

## 🛡️ Security Settings

### Cloudflare Security Settings

1. **Firewall Rules**:
   - Rate limit API endpoints
   - Block suspicious traffic patterns

2. **WAF Rules**:
   - Enable Web Application Firewall
   - Log API access attempts

3. **Bot Protection**:
   - Enable Bot Fight Mode for non-API routes

### API Security

Your API will be available at:
- **Public**: `https://api.baytlabs.com`
- **Sandboxes**: `https://<id>.baytlabs.com`

---

## 📝 Deployment Steps

1. **Update DNS** in Cloudflare dashboard
2. **Wait for DNS propagation** (1-5 minutes)
3. **Deploy the application**:
   ```bash
   ./scripts/deploy.sh
   ```

4. **Verify setup**:
   ```bash
   curl https://api.preview.baytlabs.com/health
   ```

---

## 🧪 Testing

### Test API Health
```bash
curl -I https://api.baytlabs.com/health
```

### Test MinIO Console
```
https://minio-console.baytlabs.com
```

### Test Sandbox Creation
```bash
cd examples/basic-next-app/payloads
curl -X POST https://api.baytlabs.com/sandbox \
  -H "Content-Type: application/json" \
  -d @dev.json
```

---

## ⚡ Performance Optimization

### Cloudflare Caching

1. **Static Assets**: Cloudflare automatically caches static files
2. **API Responses**: Configure caching for non-dynamic endpoints
3. **Global Load**: Traffic served from nearest Cloudflare data center

### Bandwidth Savings

- Cloudflare compresses responses
- Caches static assets globally
- Reduces origin server load

---

## 🔍 Troubleshooting

### Common Issues

1. **SSL Certificate Errors**:
   - Wait for DNS propagation (up to 24 hours)
   - Check SSL/TLS mode is "Full (strict)"

2. **502 Bad Gateway**:
   - Verify server ports are accessible
   - Check Docker containers are running

3. **DNS Not Resolving**:
   - Double-check DNS records
   - Clear local DNS cache: `sudo systemctl flush-dns 114.114.114.114`

4. **Mixed Content Warnings**:
   - Ensure all resources use HTTPS
   - Check Traefik TLS settings

### Monitoring

1. **Cloudflare Analytics**:
   - Monitor traffic patterns
   - Check performance metrics

2. **Server Monitoring**:
   ```bash
   ./scripts/status.sh
   ```

3. **Log Monitoring**:
   ```bash
   docker compose logs -f api
   ```

---

## 🎉 Success Criteria

Your setup is complete when:
- ✅ Wildcard DNS `*.baytlabs.com` resolves
- ✅ API health check responds at `https://api.baytlabs.com/health`
- ✅ Test sandbox creates successfully
- ✅ Sandbox accessible at `https://<id>.baytlabs.com`
- ✅ HTTPS padlock shows in browser

---

## 🚀 Production Tips

1. **Rate Limiting**: Set up Cloudflare rate limits for API endpoints
2. **Monitoring**: Use Cloudflare analytics for traffic insights
3. **Backup**: Regular backups of MinIO data
4. **Updates**: Keep Cloudflare settings optimized
5. **Security**: Regular security audits via Cloudflare tools