#!/usr/bin/env node
// Raw dump of /jdev/cfg/apiKey + /jdev/sys/getPublicKey for debugging.
'use strict';
const https = require('node:https');
const { load } = require('../bin/src/miniserver-config');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { rejectUnauthorized: false, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const [ms] = await load();
  const base = ms.httpsBase();
  for (const path of ['/jdev/cfg/apiKey', '/jdev/sys/getPublicKey']) {
    console.log(`\n===== ${path} =====`);
    const r = await get(base + path);
    console.log(`HTTP ${r.status}`);
    console.log(r.body);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
