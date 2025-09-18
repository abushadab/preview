#!/usr/bin/env node

const axios = require('axios');

class CloudflareManager {
  constructor() {
    this.apiToken = process.env.CLOUDFLARE_API_TOKEN;
    this.zoneId = process.env.CLOUDFLARE_ZONE_ID;
    this.api = axios.create({
      baseURL: `https://api.cloudflare.com/client/v4/zones/${this.zoneId}`,
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json'
      }
    });
  }

  async setupSubdomain(subdomain) {
    try {
      // Check if proxy settings exist
      const proxyRules = await this.getProxyRules();
      const existingRule = proxyRules.find(rule =>
        rule.Host === `${subdomain}.baytlabs.com`
      );

      if (existingRule) {
        console.log(`✅ ${subdomain}.baytlabs.com already configured`);
        return;
      }

      // Create proxy rule
      await this.createProxyRule(subdomain);
      console.log(`✅ Created proxy rule for ${subdomain}.baytlabs.com`);

    } catch (error) {
      console.error(`❌ Failed to setup ${subdomain}:`, error.message);
    }
  }

  async getProxyRules() {
    // Note: Cloudflare API doesn't directly expose proxy rules
    // This is a simplified example
    return [];
  }

  async createProxyRule(subdomain) {
    // In reality, Cloudflare proxy rules are set via DNS records
    // with the "proxied" flag
    await this.api.post('/dns_records', {
      type: 'CNAME',
      name: subdomain,
      content: 'baytlabs.com',
      proxied: true,
      ttl: 1
    });
  }
}

// Usage: node setup-cloudflare-proxy.js <subdomain>
const subdomain = process.argv[2];
if (!subdomain) {
  console.error('Usage: node setup-cloudflare-proxy.js <subdomain>');
  process.exit(1);
}

const manager = new CloudflareManager();
manager.setupSubdomain(subdomain);