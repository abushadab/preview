// Subdomain delegation plans for Cloudflare proxy

const SUBDOMAIN_PLANS = {
  // Plan 1: Method-specific subdomains
  method_based: {
    random: 'random.baytlabs.com',
    pronounceable: 'apps.baytlabs.com',
    sequential: 'short.baytlabs.com',
    time: 'time.baytlabs.com',
    memorable: 'names.baytlabs.com'
  },

  // Plan 2: Category-specific subdomains
  category_based: {
    dev: 'dev.baytlabs.com',      // Development sandboxes
    prod: 'preview.baytlabs.com', // Production previews
    demo: 'demo.baytlabs.com',    // Demo sandboxes
    temp: 'temp.baytlabs.com'     // Temporary sandboxes
  },

  // Plan 3: Single URL with path routing
  single_endpoint: {
    all: 'sandbox.baytlabs.com/sandbox/{id}'
  }
};

// DNS records to create in Cloudflare
const DNS_RECORDS = [
  {
    type: 'CNAME',
    name: 'api',
    content: 'baytlabs.com',
    proxied: true,
    comment: 'Sandbox API'
  },
  {
    type: 'CNAME',
    name: 'sandbox',
    content: 'baytlabs.com',
    proxied: true,
    comment: 'Sandbox endpoints'
  },
  {
    type: 'CNAME',
    name: 'random',
    content: 'baytlabs.com',
    proxied: true,
    comment: 'Random URL sandboxes'
  },
  {
    type: 'CNAME',
    name: 'apps',
    content: 'baytlabs.com',
    proxied: true,
    comment: 'App sandboxes'
  },
  {
    type: 'CNAME',
    name: 'dev',
    content: 'baytlabs.com',
    proxied: true,
    comment: 'Development sandboxes'
  },
  {
    type: 'CNAME',
    name: 'temp',
    content: 'baytlabs.com',
    proxied: true,
    comment: 'Temporary sandboxes'
  }
];

// API examples for different plans
const API_EXAMPLES = {
  // Method-specific URLs
  random: `https://random.baytlabs.com/a1b2c3d4`,
  apps: `https://apps.baytlabs.com/clever-tiger-852`,
  dev: `https://dev.baytlabs.com/short-a1f7`,
  temp: `https://temp.baytlabs.com/time-20240914-1415-7f9a`,

  // Single endpoint with path
  path: `https://sandbox.baytlabs.com/sandbox/a1b2c3d4`,

  // Original wildcard (if you get Enterprise Cloudflare)
  wildcard: `https://a1b2c3d4.baytlabs.com`
};

module.exports = {
  SUBDOMAIN_PLANS,
  DNS_RECORDS,
  API_EXAMPLES
};