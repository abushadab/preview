#!/usr/bin/env node

const https = require('https');
const { execSync } = require('child_process');

class SmokeTest {
  constructor() {
    this.apiBase = 'https://api.hellyo.io';
    this.exampleFiles = this.prepareExamplePayload();
  }

  prepareExamplePayload() {
    // Basic Next.js app payload
    return {
      package: {
        path: 'package.json',
        content: Buffer.from(JSON.stringify({
          "name": "smoke-test-app",
          "version": "0.1.0",
          "scripts": {
            "dev": "next dev",
            "build": "next build",
            "start": "next start"
          },
          "dependencies": {
            "next": "^14.0.0",
            "react": "^18.2.0",
            "react-dom": "^18.2.0"
          }
        }, null, 2)).toString('base64')
      },
      page: {
        path: 'app/page.tsx',
        content: Buffer.from(`
export default function Home() {
  return (
    <main>
      <h1>🚀 Smoke Test App</h1>
      <p>This is a smoke test for hellyo.io</p>
      <p>Domain: ${process.env.PREVIEW_DOMAIN || 'hellyo.io'}</p>
      <p>Time: ${new Date().toISOString()}</p>
    </main>
  );
}
        `.trim()).toString('base64')
      },
      layout: {
        path: 'app/layout.tsx',
        content: Buffer.from(`
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
        `.trim()).toString('base64')
      },
      config: {
        path: 'next.config.mjs',
        content: Buffer.from('export default { output: "standalone" };').toString('base64')
      }
    };
  }

  async makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      https.get(url, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode, data }));
      }).on('error', reject);
    });
  }

  async testAPIHealth() {
    console.log('🔍 Testing API health...');
    try {
      const response = await this.makeRequest(`${this.apiBase}/health`);
      if (response.statusCode === 200) {
        console.log('✅ API health check passed');
        return true;
      } else {
        console.log(`❌ API health check failed: ${response.statusCode}`);
        console.log('Response:', response.data);
        return false;
      }
    } catch (error) {
      console.log('❌ API health check error:', error.message);
      return false;
    }
  }

  async createSandbox() {
    console.log('🚀 Creating sandbox...');
    try {
      const postData = JSON.stringify({
        mode: 'dev',
        ttlMinutes: 5, // Short TTL for testing
        files: Object.values(this.exampleFiles)
      });

      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(`${this.apiBase}/sandbox`, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          console.log(`Status: ${res.statusCode}`);
          if (res.statusCode === 202) {
            const result = JSON.parse(data);
            console.log('✅ Sandbox created:');
            console.log(`   ID: ${result.id}`);
            console.log(`   URL: ${result.url}`);

            // Store for cleanup
            console.log('\n⏳ Waiting 10 seconds before testing URL...');
            setTimeout(() => this.testSandboxURL(result.url, result.id), 10000);
          } else {
            console.log('❌ Sandbox creation failed:');
            console.log(data);
          }
        });
      });

      req.on('error', (error) => {
        console.log('❌ Sandbox creation error:', error.message);
      });

      req.write(postData);
      req.end();

    } catch (error) {
      console.log('❌ Create sandbox error:', error.message);
    }
  }

  async testSandboxURL(url, sandboxId) {
    console.log(`🌐 Testing sandbox URL: ${url}`);
    try {
      const response = await this.makeRequest(url, { timeout: 5000 });
      if (response.statusCode === 200) {
        console.log('✅ Sandbox URL is working!');
        console.log(`   Status: ${response.statusCode}`);

        // Schedule cleanup
        console.log(`\n🧹 Cleaning up sandbox ${sandboxId} in 30 seconds...`);
        setTimeout(() => this.cleanupSandbox(sandboxId), 30000);
      } else {
        console.log(`⚠️ Sandbox URL responded with: ${response.statusCode}`);
        if (response.data) {
          console.log('Response preview:', response.data.substring(0, 200));
        }
      }
    } catch (error) {
      console.log(`❌ Sandbox URL test failed: ${error.message}`);
      console.log('The sandbox might still be starting up...');
    }
  }

  async cleanupSandbox(sandboxId) {
    console.log(`🧹 Cleaning up sandbox: ${sandboxId}`);
    try {
      const options = {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      };

      const req = https.request(`${this.apiBase}/sandbox/${sandboxId}`, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            console.log('✅ Sandbox cleaned up successfully');
          } else {
            console.log(`⚠️ Cleanup response: ${res.statusCode}`, data);
          }
        });
      });

      req.on('error', (error) => {
        console.log('❌ Cleanup error:', error.message);
      });

      req.end();

    } catch (error) {
      console.log('❌ Cleanup error:', error.message);
    }
  }

  async run() {
    console.log('🚀 Starting smoke test for hellyo.io\n');

    // Test API health first
    const apiHealthy = await this.testAPIHealth();
    if (!apiHealthy) {
      console.log('\n❌ Smoke test failed: API not healthy');
      console.log('Make sure the tunnel is running and services are deployed');
      return;
    }

    // Create and test sandbox
    await this.createSandbox();

    console.log('\n🎯 Smoke test initiated!');
    console.log('Monitor the output for results...\n');
    console.log('ℹ️  Expected URL: https://<random-id>.hellyo.io');
    console.log('ℹ️  Expected behavior: HTTPS, working Next.js app, auto-cleanup');
  }
}

// Run smoke test
const test = new SmokeTest();
test.run().catch(console.error);