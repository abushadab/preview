# Cloudflare Tunnel Setup

## Quick Setup (Run as root)

### 1. Install cloudflared
```bash
sudo apt update
sudo apt install cloudflared
```

### 2. Login to Cloudflare
```bash
cloudflared tunnel login
```

### 3. Run setup script
```bash
cd /home/claudable/preview
node scripts/setup-tunnel.js
```

### 4. Create DNS records
```bash
node scripts/create-dns.js
```

### 5. Start tunnel
```bash
cloudflared tunnel run --config cloudflare/config.yml
```

## URLs After Setup
- API: `https://api.baytlabs.com`
- Sandboxes: `https://clever-tiger-123.sandbox.baytlabs.com`

## Auto URL Generation
```bash
# Generate friendly name
node scripts/generate-friendly-name.js
# Example output: clever-tiger-456

# URL: https://clever-tiger-456.sandbox.baytlabs.com
```