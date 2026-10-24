/**
 * @file tools/dev-server.ts
 * @description Standalone, unauthenticated server for /api/tools/* — for local development and
 * the tools test suite only. Never expose it publicly.
 *
 *   npx tsc && node dist/libs/tools/dev-server.js        (PORT defaults to 4100)
 */

import 'dotenv/config';
import { createServer } from 'http';
import { handleToolsRequest } from './index';

const port = Number(process.env.PORT || 4100);

createServer(async (req, res) => {
  if (!(await handleToolsRequest(req, res))) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not a tools route' }));
  }
}).listen(port, '127.0.0.1', () => console.log(`tools dev server on http://127.0.0.1:${port}`));
