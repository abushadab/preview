#!/usr/bin/env node

/**
 * Quality concurrent sandbox test
 * Generates proper JSON with unique sandbox data and base64 encoding
 */

const crypto = require('crypto');

// Individual sandbox creator function
function createTestSandbox(id) {
  const serverContent = `const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Concurrency Test #${id} Working! Sandbox: ' + process.env.SANDBOX_ID || 'unknown');
});

app.listen(port, () => {
  console.log('Sandbox ${id} running on port ' + port);
});`;

  const packageContent = {
    name: `concurrency-test-${id}`,
    version: "1.0.0",
    scripts: {
      start: "node server.js"
    },
    dependencies: {
      express: "^4.18.2"
    }
  };

  return {
    mode: "dev",
    ttlMinutes: 3,
    files: [
      {
        path: "package.json",
        content: Buffer.from(JSON.stringify(packageContent, null, 2)).toString('base64')
      },
      {
        path: "server.js",
        content: Buffer.from(serverContent).toString('base64')
      }
    ]
  };
}

// Generate test sandboxes
const sandboxes = [];
for (let i = 1; i <= 5; i++) {
  sandboxes.push(createTestSandbox(i));
}

// Output JSON for curl commands
console.log("=== Quality Concurrent Sandbox Test Data ===\n");
sandboxes.forEach((sandbox, index) => {
  const jsonString = JSON.stringify(sandbox);
  console.log(`Sandbox #${index + 1}:`);
  console.log(`curl -H "Host: api.hellyo.io" http://localhost/sandbox -X POST -H "Content-Type: application/json" -d '${jsonString}'`);
  console.log("");
});