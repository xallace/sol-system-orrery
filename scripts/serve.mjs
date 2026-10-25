#!/usr/bin/env node
/**
 * Zero-dependency static file server for the orrery.
 * Usage: node scripts/serve.mjs [port]
 */
import { createOrreryServer, listen } from './server.mjs';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.argv[2] || process.env.PORT || 4173);
const server = createOrreryServer();

const info = await listen(server, PORT, HOST);
console.log(`Sol System explorer running at ${info.url}`);
console.log('Press Ctrl+C to stop.');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
