#!/usr/bin/env node
/* Runs the web vitest suite and fails only on failures that are NOT listed in
   known-test-failures.txt. Used by CI (.github/workflows/worker.yml) through
   `npm run test:ci`; `npx vitest run` is still the plain local run.

   Why not `it.skip`: the listed tests belong to other work in progress, and
   skipping would stop them being run at all. Here they run every time, and a
   listed test that starts passing is called out so the list only shrinks. */
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const known = new Set(readFileSync(join(root, 'known-test-failures.txt'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')))

const dir = mkdtempSync(join(tmpdir(), 'vitest-'))
const out = join(dir, 'results.json')
const run = spawnSync('npx', ['vitest', 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${out}`],
  { cwd: root, stdio: 'inherit' })

let report
try { report = JSON.parse(readFileSync(out, 'utf8')) } catch {
  console.error(`vitest produced no JSON report (exit ${run.status}); treating the run as failed`)
  process.exit(1)
} finally { rmSync(dir, { recursive: true, force: true }) }

const failed = [], fixed = []
for (const file of report.testResults ?? []) {
  const rel = relative(root, file.name)
  if (file.status === 'failed' && (file.assertionResults ?? []).length === 0) failed.push(`${rel} (the file failed to load: ${file.message ?? ''})`)
  for (const t of file.assertionResults ?? []) {
    const name = [rel, ...(t.ancestorTitles ?? []), t.title].join(' > ')
    if (t.status === 'failed' && !known.has(name)) failed.push(name)
    if (t.status === 'passed' && known.has(name)) fixed.push(name)
  }
}

if (fixed.length) {
  console.log('\nListed as known failures but now passing; delete these lines from known-test-failures.txt:')
  for (const n of fixed) console.log('  ' + n)
}
if (failed.length) {
  console.error('\nNew test failures (not in known-test-failures.txt):')
  for (const n of failed) console.error('  ' + n)
  process.exit(1)
}
console.log(`\nweb tests: ${report.numPassedTests} passed, ${report.numFailedTests} failed, all failures known (${known.size} listed).`)
