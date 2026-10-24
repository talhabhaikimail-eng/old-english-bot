// Runs the /api/tools test suite against a freshly started tools dev server.
//   node src/scripts/tools-tests/run-all.mjs [filter...]     e.g. `image docs`
// Env: TOOLS_TEST_PORT (default 4100). Set TOOLS_URL to test an already-running server instead.
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const filters = process.argv.slice(2);
const port = Number(process.env.TOOLS_TEST_PORT || 4100);

let server;
if (!process.env.TOOLS_URL) {
  process.env.TOOLS_URL = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'src/libs/tools/dev-server.ts')], {
    cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; process.stderr.write(d); });
  const start = Date.now();
  while (!log.includes('tools dev server on')) {
    if (server.exitCode !== null || Date.now() - start > 60_000) { console.error('server failed to start\n' + log); process.exit(1); }
    await new Promise(r => setTimeout(r, 200));
  }
  // Let background binary probes finish so timing-sensitive tests aren't skewed.
  await fetch(`${process.env.TOOLS_URL}/api/tools/capabilities`).catch(() => {});
}

const { _registered } = await import('./lib.mjs');
const files = (await readdir(here))
  .filter(f => f.endsWith('.test.mjs') && (!filters.length || filters.some(x => f.includes(x))))
  .sort();
let passed = 0;
const failed = [];
for (const f of files) {
  await import(pathToFileURL(join(here, f)).href);
  const tests = _registered();
  console.log(`\n${f}`);
  for (const t of tests) {
    const t0 = Date.now();
    try {
      await t.fn();
      passed++;
      console.log(`  ✓ ${t.name} (${Date.now() - t0}ms)`);
    } catch (e) {
      failed.push(`${f} › ${t.name}`);
      console.log(`  ✗ ${t.name}\n      ${String(e?.stack || e).split('\n').slice(0, 4).join('\n      ')}`);
    }
  }
}
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) console.log(failed.map(x => '  - ' + x).join('\n'));
process.exitCode = failed.length ? 1 : 0;
if (server) {
  // Wait for the child to exit; calling process.exit right after kill trips a libuv assert on Windows.
  const exited = new Promise(r => server.once('exit', r));
  server.kill();
  await exited;
}
