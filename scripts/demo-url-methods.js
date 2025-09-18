#!/usr/bin/env node

const URLGenerator = require('../api/utils/urlGenerator');

async function demoURLGeneration() {
  const generator = new URLGenerator();

  console.log('🎯 Auto URL Generation Demo');
  console.log('============================\n');

  const demoMethods = [
    { method: 'random', description: 'Random 8-character hex' },
    { method: 'random', options: { length: 12 }, description: 'Random 12-character hex' },
    { method: 'sequential', description: 'Sequential base36 IDs' },
    { method: 'pronounceable', description: 'Adjective-noun-number combinations' },
    { method: 'uuid', description: 'UUID-based (8 chars)' },
    { method: 'memorable', description: 'Military alphabet + numbers' },
    { method: 'time', description: 'Timestamp + random' },
    { method: 'hash', options: { input: 'my-project-v1' }, description: 'Hash-based (deterministic)' }
  ];

  for (const { method, options = {}, description } of demoMethods) {
    console.log(`📋 ${description}:`);
    const urls = [];

    for (let i = 0; i < 3; i++) {
      const id = generator.generate(method, options);
      urls.push(`https://${id}.baytlabs.com`);
    }

    urls.forEach(url => console.log(`   ${url}`));
    console.log('');
  }

  // Show how to use in API calls
  console.log('🚀 API Usage Examples:');
  console.log('=====================\n');

  console.log('1. Random URLs (default):');
  console.log(`curl -X POST https://api.baytlabs.com/sandbox \\
  -H "Content-Type: application/json" \\
  -d '{
    "mode": "dev",
    "files": [...]
  }'\n`);

  console.log('2. Pronounceable URLs:');
  console.log(`curl -X POST https://api.baytlabs.com/sandbox \\
  -H "Content-Type: application/json" \\
  -d '{
    "mode": "dev",
    "urlMethod": "pronounceable",
    "files": [...]
  }'\n`);

  console.log('3. Deterministic URLs (same code = same URL):');
  console.log(`curl -X POST https://api.baytlabs.com/sandbox \\
  -H "Content-Type: application/json" \\
  -d '{
    "mode": "dev",
    "urlMethod": "hash",
    "urlOptions": {
      "input": "my-project-unique-code"
    },
    "files": [...]
  }'\n`);

  console.log('4. Time-based URLs:');
  console.log(`curl -X POST https://api.baytlabs.com/sandbox \\
  -H "Content-Type: application/json" \\
  -d '{
    "mode": "dev",
    "urlMethod": "time",
    "files": [...]
  }'\n`);
}

if (require.main === module) {
  demoURLGeneration().catch(console.error);
}

module.exports = { demoURLGeneration };