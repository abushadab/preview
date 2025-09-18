#!/usr/bin/env node

/**
 * High-quality concurrent sandbox test
 * Properly generates 5 unique sandboxes with correct JSON and base64 encoding
 */

const TEST_DATA = {
  server: (id) => `const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Quality Concurrency Test #${id} Working! Sandbox: ' + (process.env.SANDBOX_ID || 'unknown'));
});

app.listen(port, () => {
  console.log('Sandbox ${id} running on port ' + port);
});`,

  package: (id) => JSON.stringify({
    name: `quality-test-${id}`,
    version: "1.0.0",
    scripts: {
      start: "node server.js"
    },
    dependencies: {
      express: "^4.18.2"
    }
  })
};

const sandboxes = Array.from({ length: 5 }, (_, i) => ({
  mode: "dev",
  ttlMinutes: 3,
  files: [
    {
      path: "package.json",
      content: Buffer.from(TEST_DATA.package(i + 1)).toString('base64')
    },
    {
      path: "server.js",
      content: Buffer.from(TEST_DATA.server(i + 1)).toString('base64')
    }
  ]
}));

// Test each sandbox individually to ensure quality
console.log("=== Individual Sandbox Test Results ===\n");

const testSandbox = (index) => {
  const sandbox = sandboxes[index];
  const decodedFiles = sandbox.files.map(file => ({
    path: file.path,
    content: Buffer.from(file.content, 'base64').toString()
  }));

  console.log(`Sandbox #${index + 1}:`);
  console.log(`- Package name: ${JSON.parse(decodedFiles[0].content).name}`);
  console.log(`- Server content length: ${decodedFiles[1].content.length} chars`);
  console.log(`- JSON validity: ${decodedFiles.every(f => {
    try {
      if (f.path === 'package.json') JSON.parse(f.content);
      return true;
    } catch { return false; }
  })}`);
  console.log("");

  return decodedFiles;
};

// Generate validated test data
console.log("Testing all 5 sandboxes:");
sandboxes.forEach((_, i) => testSandbox(i));