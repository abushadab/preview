#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');

async function asyncReadFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function prepareExamplePayload() {
  try {
    const exampleDir = path.join(__dirname, '../examples/basic-next-app');

    // Files to include in the payload
    const filesToInclude = [
      'package.json',
      'next.config.mjs',
      'tailwind.config.js',
      'postcss.config.js',
      'app/page.tsx',
      'app/layout.tsx',
      'app/globals.css',
      'app/api/health/route.ts'
    ];

    const payloadFiles = [];

    for (const filePath of filesToInclude) {
      const fullPath = path.join(exampleDir, filePath);
      const content = await asyncReadFile(fullPath);

      if (content !== null) {
        const base64Content = Buffer.from(content).toString('base64');
        payloadFiles.push({
          path: filePath,
          content: base64Content
        });
        console.log(`✓ Added: ${filePath}`);
      } else {
        console.warn(`⚠️  File not found: ${filePath}`);
      }
    }

    // Create API payloads
    const devPayload = {
      mode: 'dev',
      ttlMinutes: 45,
      env: {
        NEXT_PUBLIC_SANDBOX_ID: 'example-dev'
      },
      files: payloadFiles
    };

    const prodPayload = {
      mode: 'prod',
      ttlMinutes: 240,
      env: {
        NEXT_PUBLIC_SANDBOX_ID: 'example-prod'
      },
      files: payloadFiles
    };

    // Save payloads
    const payloadDir = path.join(exampleDir, 'payloads');
    await fs.mkdir(payloadDir, { recursive: true });

    await fs.writeFile(
      path.join(payloadDir, 'dev.json'),
      JSON.stringify(devPayload, null, 2)
    );
    console.log('✓ Created: examples/basic-next-app/payloads/dev.json');

    await fs.writeFile(
      path.join(payloadDir, 'prod.json'),
      JSON.stringify(prodPayload, null, 2)
    );
    console.log('✓ Created: examples/basic-next-app/payloads/prod.json');

    // Create curl commands
    const devCurl = `curl -X POST http://api.preview.example.com/sandbox \\
  -H "Content-Type: application/json" \\
  -d @payloads/dev.json`;

    const prodCurl = `curl -X POST http://api.preview.example.com/sandbox \\
  -H "Content-Type: application/json" \\
  -d @payloads/prod.json`;

    await fs.writeFile(path.join(payloadDir, 'dev-curl.sh'), devCurl + '\n');
    console.log('✓ Created: examples/basic-next-app/payloads/dev-curl.sh');

    await fs.writeFile(path.join(payloadDir, 'prod-curl.sh'), prodCurl + '\n');
    console.log('✓ Created: examples/basic-next-app/payloads/prod-curl.sh');

    console.log('\n🎉 Example payloads prepared successfully!');
    console.log('\n📁 Location: examples/basic-next-app/payloads/');
    console.log('\n📝 Usage:');
    console.log('  cd examples/basic-next-app');
    console.log('  bash payloads/dev-curl.sh');
    console.log('  bash payloads/prod-curl.sh');

  } catch (error) {
    console.error('❌ Error preparing example payloads:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  prepareExamplePayload();
}

module.exports = { prepareExamplePayload };