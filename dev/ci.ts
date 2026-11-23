#!/usr/bin/env bun
// The whole check, as CI and the pre-push hook run it: every check at once,
// every failure listed, and a check that runs past its budget fails too.
//
//   bun run ci              all checks
//   bun run ci lint test    only these

import { Glob } from 'bun'
import { readFileSync } from 'node:fs'

type Check = {
  name: string
  cmd: string[]
  cwd?: string
  /** Wall-clock budget in milliseconds: slower fails. */
  budgetMs: number
  /** Extra proof on the output, beyond exit code 0. Returns a failure message, or null. */
  verify?: (out: string) => string | null
}

const ROOT = new URL('..', import.meta.url).pathname
const DC = `${ROOT}plugins/drive-cleanup`
const PCG = `${ROOT}plugins/pc-guardian`

const countFiles = (pattern: string, cwd: string): number => [...new Glob(pattern).scanSync({ cwd })].length

/** Every test file on disk must have run: a runner that silently skips one is a lie. */
const ranAll = (pattern: string, cwd: string) => (out: string) => {
  const want = countFiles(pattern, cwd)
  const m = /Ran \d+ tests? across (\d+) files?/.exec(out)
  const got = m ? Number(m[1]) : -1
  if (want === 0) return `no test files match ${pattern}`
  return got === want ? null : `ran ${got} test files, found ${want} on disk (${pattern})`
}

/** A skipped or todo test is a hidden failure: none may be reported. */
const noneSkipped = (out: string): string | null => {
  const hidden = [...out.matchAll(/^\s*([1-9]\d*) (skip|todo)$/gm)].map(m => `${m[1]} ${m[2]}`)
  return hidden.length > 0 ? `tests not run: ${hidden.join(', ')}` : null
}

const all =
  (...checks: ((out: string) => string | null)[]) =>
  (out: string): string | null =>
    checks.map(c => c(out)).find(m => m !== null) ?? null

/** The vendored claude-code types must come from the Claude Code version CI installs. */
const typesMatchCli = (out: string) => {
  const first = readFileSync(`${ROOT}dev/types/claude-code/index.d.ts`, 'utf8').split('\n', 1)[0] ?? ''
  const typesVersion = /Claude Code (\S+)\./.exec(first)?.[1]
  const cliVersion = /^(\S+) \(Claude Code\)/m.exec(out)?.[1]
  return typesVersion && typesVersion === cliVersion
    ? null
    : `dev/types/claude-code is from Claude Code ${typesVersion}, the CLI is ${cliVersion}: update one to match`
}

const CHECKS: Check[] = [
  { name: 'fmt', cmd: ['bun', 'fmt', '--check', '--no-script', '.'], budgetMs: 1_000 },
  { name: 'lint', cmd: ['bun', 'run', 'lint'], budgetMs: 1_000 },
  { name: 'typecheck:mod', cmd: ['bun', 'check', '--all', '--no-pretty'], budgetMs: 5_000 },
  { name: 'typecheck:dev', cmd: ['bun', 'check', '-p', 'tsconfig.node.json', '--all', '--no-pretty'], budgetMs: 5_000 },
  {
    name: 'test',
    cmd: ['bun', 'test'],
    budgetMs: 30_000,
    verify: all(ranAll('plugins/drive-cleanup/dev/test/*.spec.ts', ROOT), noneSkipped),
  },
  {
    name: 'test:mod',
    cmd: ['claude', 'plugin', 'test', '.'],
    cwd: DC,
    budgetMs: 30_000,
    verify: all(ranAll('**/*.test.{ts,tsx}', DC), noneSkipped),
  },
  {
    name: 'test:mod:pc-guardian',
    cmd: ['claude', 'plugin', 'test', '.'],
    cwd: PCG,
    budgetMs: 30_000,
    verify: all(ranAll('**/*.test.{ts,tsx}', PCG), noneSkipped),
  },
  { name: 'script-hashes', cmd: ['bun', 'dev/update-hashes.mjs', '--check'], cwd: DC, budgetMs: 1_000 },
  { name: 'validate:marketplace', cmd: ['claude', 'plugin', 'validate', '.'], budgetMs: 10_000 },
  ...['pc-guardian', 'drive-cleanup'].map(p => ({
    name: `validate:${p}`,
    cmd: ['claude', 'plugin', 'validate', `plugins/${p}`],
    budgetMs: 10_000,
  })),
  { name: 'types-version', cmd: ['claude', '--version'], budgetMs: 5_000, verify: typesMatchCli },
]

type Result = { check: Check; ok: boolean; ms: number; out: string; why: string[] }

async function run(check: Check): Promise<Result> {
  const t0 = performance.now()
  const proc = Bun.spawn(check.cmd, {
    cwd: check.cwd ?? ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const ms = performance.now() - t0
  const out = stdout + stderr
  const why: string[] = []
  if (code !== 0) why.push(`exit ${code}`)
  const extra = code === 0 ? check.verify?.(out) : null
  if (extra) why.push(extra)
  if (ms > check.budgetMs) why.push(`took ${fmtMs(ms)}, budget ${fmtMs(check.budgetMs)}`)
  return { check, ok: why.length === 0, ms, out, why }
}

const fmtMs = (ms: number) => (ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`)

const only = process.argv.slice(2)
const picked = only.length > 0 ? CHECKS.filter(c => only.some(o => c.name === o || c.name.startsWith(`${o}:`))) : CHECKS
if (picked.length === 0) {
  console.error(`No check named ${only.join(', ')}. Checks: ${CHECKS.map(c => c.name).join(', ')}`)
  process.exit(2)
}

const t0 = performance.now()
const results = await Promise.all(picked.map(c => run(c)))
const failed = results.filter(r => !r.ok)

for (const r of failed) {
  console.log(`\n──── ${r.check.name} FAILED: ${r.why.join('; ')}\n$ ${r.check.cmd.join(' ')}\n${r.out.trimEnd()}`)
}
console.log('\n')
for (const r of results) {
  console.log(
    `${r.ok ? 'ok  ' : 'FAIL'}  ${r.check.name.padEnd(24)} ${fmtMs(r.ms).padStart(7)}  / ${fmtMs(r.check.budgetMs)}`,
  )
}
console.log(
  `\n${failed.length > 0 ? `${failed.length} of ${results.length} checks failed` : `all ${results.length} checks passed`} in ${fmtMs(performance.now() - t0)}`,
)

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map(
    r =>
      `| ${r.ok ? '✅' : '❌'} | ${r.check.name} | ${fmtMs(r.ms)} | ${fmtMs(r.check.budgetMs)} | ${r.why.join('; ')} |`,
  )
  await Bun.write(
    process.env.GITHUB_STEP_SUMMARY,
    ['| | Check | Time | Budget | Why |', '| --- | --- | ---: | ---: | --- |', ...rows, ''].join('\n'),
  )
}
process.exit(failed.length > 0 ? 1 : 0)
