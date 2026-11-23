// Engine tests for PC Guardian's propose_cleanup: `claude plugin test plugins/pc-guardian`.
// The kit cannot play a person's yes, so these cover what must never change
// anything: bad input, no Windows, and no one to answer.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const APPDATA = 'C:\\Users\\Asha\\AppData\\Roaming'

function world(on: On, runs: string[][], registered: string[] = []): void {
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.write', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.register', (_, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__pc-guardian__${e.name}` } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

const textOf = (r: unknown): string => {
  const result = (r as { result?: unknown }).result
  return typeof result === 'string' ? result : JSON.stringify(r)
}

test('registers propose_cleanup beside the read-only tools', async ($, on) => {
  const names: string[] = []
  world(on, [], names)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(names).toContain('propose_cleanup')
  expect(names).toContain('get_cleanup_preview')
  expect(names.some(n => /delete|remove|purge|empty|set_/.test(n))).toBe(false)
})

test('propose_cleanup refuses bad kinds before measuring anything', async ($, on) => {
  const runs: string[][] = []
  world(on, runs)
  mock.env(on, { APPDATA })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const answer = textOf(await $.tool.call({ tool: 'mcp__pc-guardian__propose_cleanup', kinds: ['format_c'] }))
  expect(answer).toContain('Invalid input')
  expect(runs.length).toBe(0)
})

test('away from Windows, propose_cleanup measures nothing and cleans nothing', async ($, on) => {
  const runs: string[][] = []
  world(on, runs)
  mock.env(on, { APPDATA })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const answer = textOf(await $.tool.call({ tool: 'mcp__pc-guardian__propose_cleanup', kinds: ['recycle_bin'] }))
  expect(answer).toContain('not measured')
  expect(runs.length).toBe(0)
})
