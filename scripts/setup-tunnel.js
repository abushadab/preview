#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class CloudflareTunnelSetup {
  constructor() {
    this.configDir = path.join(__dirname, '../cloudflare');
    this.configPath = path.join(this.configDir, 'config.yml');
  }

  async setup() {
    try {
      console.log('🚀 Setting up Cloudflare Tunnel...\n');

      // Step 1: Authenticate and create tunnel
      console.log('Step 1: Creating tunnel...');
      const tunnelId = this.createTunnel();
      console.log('✅ Tunnel created:', tunnelId);

      // Step 2: Update config file
      console.log('\nStep 2: Updating config file...');
      this.updateConfig(tunnelId);
      console.log('✅ Config updated');

      // Step 3: Create DNS setup script
      console.log('\nStep 3: Creating scripts...');
      this.createScripts(tunnelId);
      console.log('✅ Scripts ready');

      console.log('\n🎉 Tunnel setup complete!');
      console.log('\nNext steps:');
      console.log('1. Run: node scripts/create-dns.js');
      console.log('2. Start tunnel: cloudflared tunnel run --config cloudflare/config.yml');

    } catch (error) {
      console.error('❌ Setup failed:', error.message);
      process.exit(1);
    }
  }

  createTunnel() {
    try {
      const output = execSync('cloudflared tunnel create sandbox-platform', {
        encoding: 'utf8'
      });

      tunnelId = output.match(/Created tunnel ([\w-]+)/)[1];
      console.log('✅ Tunnel created:', tunnelId);

      // Move credentials to preview directory
      const credFile = `/root/.cloudflared/${tunnelId}.json`;
      if (fs.existsSync(credFile)) {
        fs.copyFileSync(credFile, path.join(this.configDir, `${tunnelId}.json`));
        console.log('✅ Credentials copied');
      }

      return tunnelId;
    } catch (error) {
      throw new Error(`Failed to create tunnel: ${error.message}`);
    }
  }

  updateConfig(tunnelId) {
    let config = fs.readFileSync(this.configPath, 'utf8');
    config = config.replace('<TUNNEL_ID>', tunnelId);
    fs.writeFileSync(this.configPath, config);
  }

  createScripts(tunnelId) {
    // DNS creation script
    const dnsScript = `#!/usr/bin/env node

const { execSync } = require('child_process');

const TUNNEL_ID = '${tunnelId}';

function createDNSRecord(hostname) {
  try {
    execSync(\`cloudflared tunnel route dns \${TUNNEL_ID} \${hostname}\`, {
      stdio: 'inherit'
    });
    console.log(\`✅ Created DNS: \${hostname}\`);
  } catch (error) {
    console.error(\`❌ Failed to create \${hostname}:\`, error.message);
  }
}

// Create base DNS records
console.log('Creating base DNS records...');
createDNSRecord('api.baytlabs.com');
createDNSRecord('*.sandbox.baytlabs.com');

console.log('\\n🚀 DNS setup complete!');
`;

    fs.writeFileSync(path.join(__dirname, 'create-dns.js'), dnsScript);
    fs.chmodSync(path.join(__dirname, 'create-dns.js'), '755');

    // URL-friendly name generator
    const urlGenScript = `#!/usr/bin/env node

const adjectives = [
  'clever', 'quick', 'swift', 'bright', 'smart', 'fast', 'cool', 'nice',
  'calm', 'bold', 'brave', 'kind', 'gentle', 'happy', 'sunny', 'merry'
];

const nouns = [
  'tiger', 'fox', 'cat', 'dog', 'bird', 'fish', 'lion', 'bear',
  'tree', 'river', 'ocean', 'cloud', 'star', 'moon', 'sun', 'sky'
];

function generateFriendlyName() {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 1000);
  return \`\${adj}-\${noun}-\${num}\`;
}

const friendlyName = generateFriendlyName();
console.log(friendlyName);

// If CLI argument, create DNS record
if (process.argv[2] === '--create-dns') {
  require('./create-dns'); // This would need to be adjusted
}`;

    fs.writeFileSync(path.join(__dirname, 'generate-friendly-name.js'), urlGenScript);
    fs.chmodSync(path.join(__dirname, 'generate-friendly-name.js'), '755');
  }
}

if (require.main === module) {
  const setup = new CloudflareTunnelSetup();
  setup.setup();
}

module.exports = CloudflareTunnelSetup;