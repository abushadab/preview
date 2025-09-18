#!/usr/bin/env node
const WebSocket = require('ws');

const domain = process.env.PREVIEW_DOMAIN || 'localhost';
const token = process.env.API_TOKEN || process.env.TOKEN || '';
const base = process.env.PREVIEW_BASE || '127.0.0.1';
const sandboxId = process.env.SANDBOX_ID || 'demo-id';

function openSocket(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${base}/sandbox/logs?sandboxId=${sandboxId}`, { headers });
    let settled = false;
    ws.on('open', () => {
      if (!headers.Authorization) {
        ws.close();
      } else if (!settled) {
        settled = true;
        resolve({ type: 'open', socket: ws });
        ws.close();
      }
    });
    ws.on('close', (code, reason) => {
      if (!settled) {
        settled = true;
        resolve({ type: 'close', code, reason: reason.toString() });
      }
    });
    ws.on('error', (err) => {
      if (!settled) {
        settled = true;
        resolve({ type: 'error', error: err });
      }
    });
  });
}

async function main() {
  const hostHeader = `api.${domain}`;
  const unauth = await openSocket({ Host: hostHeader });
  if (unauth.code !== 1008) {
    console.error(`❌ Expected 1008 close without token, got ${unauth.code}`);
    process.exit(1);
  }
  const masked = token ? `${token.slice(0, 2)}****` : '****';
  console.log(`✅ Unauthorized close verified (code ${unauth.code})`);

  const auth = await openSocket({ Host: hostHeader, Authorization: `Bearer ${token}` });
  if (auth.type !== 'open') {
    console.error(`❌ Expected successful connection with token ${masked}`);
    process.exit(1);
  }
  console.log(`✅ Authorized connection succeeded with token ${masked}`);
}

main().catch((err) => {
  console.error('❌ WS auth test failed', err);
  process.exit(1);
});
