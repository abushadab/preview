# 🚨 Wildcard DNS Setup Instructions

## 🔒 SECURITY EMERGENCY

**IMMEDIATE:** Rotate the exposed token in Cloudflare dashboard:
- Current token: `duiFvo1IukQp4G1HsWpe-Rxwyr-j4d25PsTc5LpL`
- Go to Cloudflare Dashboard → Tokens → Invalidate this token
- Create new token scoped only to DNS:Edit for hellyo.io and baytlabs.com

---

## ☁️ Step 1: Create Wildcard DNS Records

### In Cloudflare Dashboard:

#### For hellyo.io:
```
Type: CNAME
Name: *
Content: 283db517-5962-42cf-9681-aa056c92de35.cfargotunnel.com
Proxy status: Proxied (Orange cloud)
TTL: Auto (Auto)
```

#### For baytlabs.com:
```
Type: CNAME
Name: *
Content: 283db517-5962-42cf-9681-aa056c92de35.cfargotunnel.com
Proxy status: Proxied (Orange cloud)
TTL: Auto (Auto)
```

### Verify Setup:
```bash
# Test wildcards are working
dig abc123.hellyo.io +short
dig xyz789.baytlabs.com +short
```

---

## ⚡ Expected Result After DNS Setup

- `https://<any-id>.hellyo.io` → Tunnel → Traefik → Container
- `https://<any-id>.baytlabs.com` → Tunnel → Traefik → Container
- No API calls needed for sandbox creation
- Instant URL availability

---

## 🎯 Next: Code Implementation

Once DNS records are created, run the code implementation steps below.