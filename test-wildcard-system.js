#!/usr/bin/env node

const http = require('http');

class WildcardSystemTest {
  constructor() {
    this.apiBase = 'http://localhost';
    this.exampleFiles = this.getExamplePayload();
  }

  getExamplePayload() {
    return {
      package: {
        path: 'package.json',
        content: Buffer.from(JSON.stringify({
          "name": "wildcard-test-app",
          "version": "0.1.0",
          "scripts": { "start": "node server.js" },
          "dependencies": { "express": "^4.18.2" }
        }, null, 2)).toString('base64')
      },
      server: {
        path: 'server.js',
        content: Buffer.from(`
const express = require('express');
const app = express();
const port = process.env.PORT || '3000';

app.get('/', (req, res) => {
  res.send(\`
    <h1>🚀 Wildcard DNS Test Success!</h1>
    <p>Sandbox ID: ${process.env.SANDBOX_ID}</p>
    <p>Domain: ${process.env.DOMAIN}</p>
    <p>Port: 3000</p>
    <p>Time: ${new Date().toISOString()}</p>
  \`);
});

app.listen(port, '0.0.0.0', () => {
  console.log('Server running on port', port);
});
        `.trim()).toString('base64')
      }
    };
  }

  async makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      const defaultOptions = {
        headers: {
          'Host': 'api.hellyo.io'
        }
      };
      const mergedOptions = { ...defaultOptions, ...options };

      http.get(url, mergedOptions, (res) => {
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
        return false;
      }
    } catch (error) {
      console.log('❌ API health check error:', error.message);
      return false;
    }
  }

  async createSandbox() {
    console.log('🚀 Creating sandbox with wildcard DNS...');
    try {
      const postData = JSON.stringify({
        mode: 'dev',
        ttlMinutes: 5,
        files: Object.values(this.exampleFiles)
      });

      const options = {
        method: 'POST',
        headers: {
          'Host': 'api.hellyo.io',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = http.request(`${this.apiBase}/sandbox`, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          console.log(`Status: ${res.statusCode}`);
          if (res.statusCode === 202) {
            const result = JSON.parse(data);
            console.log('✅ Sandbox created successfully!');
            console.log(`   ID: ${result.id}`);
            console.log(`   URL: ${result.url}`);
            console.log(`   Status: ${result.status}`);

            this.testSandboxURL(result.url, result.id);
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
    console.log(`\n⏳ Testing sandbox URL: ${url}`);

    // Wait a moment for container to start
    setTimeout(async () => {
      try {
        console.log('🔍 Checking if sandbox is ready...');
        const response = await this.makeRequest(url, { timeout: 10000 });
        if (response.statusCode === 200) {
          console.log('✅ Sandbox URL working perfectly!');
          console.log(`   Status: ${response.statusCode}`);

          if (response.data) {
            console.log('✅ Content received:');
            const titleMatch = response.data.match(/<h1>(.*?)<\/h1>/);
            console.log(`   Title: ${titleMatch ? titleMatch[1] : 'N/A'}`);
          }
        } else {
          console.log(`⚠️  Sandbox responded with: ${response.statusCode}`);
          if (response.data) {
            console.log('Response preview:', response.data.substring(0, 200));
          }
        }
      } catch (error) {
        console.log(`❌ Sandbox URL test failed: ${error.message}`);
        console.log('The sandbox might still be starting up...');
      }
    }, 8000); // Wait 8 seconds for container to start
  }

  async testConcurrentSandboxes() {
    console.log('\n🚀 Testing 5 concurrent sandboxes...');
    console.log('This will create 5 sandboxes simultaneously to test wildcard DNS scalability.\n');

    const sandboxPromises = [];

    for (let i = 0; i < 5; i++) {
      const postData = JSON.stringify({
        mode: 'dev',
        ttlMinutes: 5,
        files: Object.values(this.exampleFiles)
      });

      sandboxPromises.push(new Promise((resolve, reject) => {
        const options = {
          method: 'POST',
          headers: {
            'Host': 'api.hellyo.io',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          }
        };

        const req = http.request(`${this.apiBase}/sandbox`, options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 202) {
              const result = JSON.parse(data);
              console.log(`✅ Sandbox ${i+1}: ${result.id} → ${result.url}`);
              resolve(result);
            } else {
              console.log(`❌ Sandbox ${i+1} failed: ${res.statusCode}`);
              resolve(null);
            }
          });
        });

        req.on('error', (error) => {
          console.log(`❌ Sandbox ${i+1} error: ${error.message}`);
          resolve(null);
        });

        req.write(postData);
        req.end();
      }));
    }

    // Wait for all sandboxes to be created
    const results = await Promise.all(sandboxPromises);

    const successful = results.filter(r => r !== null);
    console.log(`\n📊 Results: ${successful.length}/5 sandboxes created successfully`);

    // Test URLs
    console.log('\n🔗 Testing all sandbox URLs...');
    for (const sandbox of successful) {
      console.log(`Testing: ${sandbox.url}`);
      // We'll test a few to avoid overwhelming the system
      if (successful.indexOf(sandbox) < 3) {
        setTimeout(() => this.testSandboxURL(sandbox.url, sandbox.id), 2000);
      }
    }
  }

  async run() {
    console.log('🚀 Testing Wildcard DNS System\n');

    // Test API health first
    const apiHealthy = await this.testAPIHealth();
    if (!apiHealthy) {
      console.log('\n❌ Test failed: API not healthy. Make sure:');
      console.log('1. Wildcard DNS records are created in Cloudflare');
      console.log('2. API service is running: docker compose up -d api');
      console.log('3. Tunnel is running: systemctl status hellyo-tunnel');
      return;
    }

    console.log('\n🎯 Choose test:');
    console.log('1. Single sandbox test');
    console.log('2. 5 concurrent sandboxes test');
    console.log('3. Both tests');

    // For now, run single test
    console.log('\n🎬 Running single sandbox test...');
    await this.createSandbox();

    // After single test, run concurrent test
    setTimeout(async () => {
      console.log('\n' + '='.repeat(50));
      await this.testConcurrentSandboxes();
    }, 15000);
  }
}

// Run the test
const test = new WildcardSystemTest();
test.run().catch(console.error);