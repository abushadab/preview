#!/usr/bin/env node

/**
 * Proper Next.js detection test
 * Creates clean JSON for auto-detection validation
 */

// Generate proper test data
const packageContent = {
  name: "next-app",
  version: "1.0.0",
  scripts: {
    dev: "next dev",
    build: "next build",
    start: "next start"
  },
  dependencies: {
    next: "^14.0.0",
    react: "^18.2.0",
    "react-dom": "^18.2.0"
  }
};

const pagesIndexContent = `export default function Home() {
  return <div>Next.js auto-detected with healthPath: '/'!</div>;
}`;

const testData = {
  mode: "dev",
  ttlMinutes: 3,
  files: [
    {
      path: "package.json",
      content: Buffer.from(JSON.stringify(packageContent, null, 2)).toString('base64')
    },
    {
      path: "pages/index.js",
      content: Buffer.from(pagesIndexContent).toString('base64')
    }
  ]
};

console.log("=== Clean Next.js Auto-Detection Test ===");
console.log("Health path should be automatically set to '/'");
console.log();
console.log(JSON.stringify(testData));