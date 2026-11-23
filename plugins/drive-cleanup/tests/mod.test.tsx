// Engine tests for Drive Cleanup's hooks module: `claude plugin test plugins/drive-cleanup`.
// The hooks registered here stand for the engine beneath the plugin: an
// in-memory file system, the environment and the process runner.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const APPDATA = 'C:\\Users\\Asha\\AppData\\Roaming'

type Files = Map<string, string>

type World = { scriptText?: string; registered?: string[] }

/**
 * An in-memory file system, and a record of processes started. The kit hands
 * hooks paths resolved against its own working directory, so a Windows path
 * arrives prefixed; `realPath` answers it as Windows would spell it.
 */
function world(on: On, files: Files, runs: string[][], opts: World = {}): void {
  const windowsSpelling = (path: string): string => path.replace(/^.*?(?=[A-Za-z]:\\)/, '')
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || [...files.keys()].some(k => k.startsWith(`${e.path}\\`)) }))
  on('fs.stat', (_, e) => ({
    value: {
      kind: files.has(e.path) ? 'file' : 'dir',
      size: 0,
      mtimeMs: 0,
      isLink: false,
      realPath: windowsSpelling(e.path),
    },
  }))
  on('fs.read', (_, e) => {
    if (opts.scriptText !== undefined && e.path.endsWith('.ps1')) return { value: opts.scriptText }
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.register', (_, e) => {
    opts.registered?.push(e.name)
    return { value: { tool: `mcp__drive-cleanup__${e.name}` } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

const textOf = (r: unknown): string => {
  const result = (r as { result?: unknown }).result
  return typeof result === 'string' ? result : JSON.stringify(r)
}

test('registers its read-only tools, and none that cleans', async ($, on) => {
  const names: string[] = []
  world(on, new Map(), [], { registered: names })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(names).toEqual([
    'self_check',
    'run_deep_scan',
    'get_scan_status',
    'get_storage_summary',
    'get_largest_files',
    'get_findings',
    'get_windows_recommendations',
    'generate_audit_reports',
    'get_dev_caches',
    'get_duplicate_groups',
    'get_quarantine',
    'get_settings',
    'verify_cleanup',
    'open_pane',
  ])
  expect(names.some(n => /clean_|delete|remove|purge|restore|move|quarantine_|set_/.test(n))).toBe(false)
})

test('away from Windows, the scan runs nothing and says why', async ($, on) => {
  const files: Files = new Map()
  const runs: string[][] = []
  world(on, files, runs)
  mock.env(on, { APPDATA, USERPROFILE: 'C:\\Users\\Asha' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const answer = textOf(await $.tool.call({ tool: 'mcp__drive-cleanup__run_deep_scan' }))
  expect(answer).toContain('Not checked')
  expect(answer).toContain('Windows was not detected')
  expect(runs.length).toBe(0)
})

test('a script that does not match its fingerprint is never run', async ($, on) => {
  const files: Files = new Map()
  const runs: string[][] = []
  // Every script read answers tampered text.
  world(on, files, runs, { scriptText: 'Remove-Item C:\\ -Recurse' })
  mock.env(on, { APPDATA, USERPROFILE: 'C:\\Users\\Asha', SystemRoot: 'C:\\Windows' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const answer = textOf(await $.tool.call({ tool: 'mcp__drive-cleanup__run_deep_scan' }))
  expect(answer).toContain('does not match its recorded fingerprint')
  expect(runs.length).toBe(0)
})

test('tools refuse bad input and answer before any scan', async ($, on) => {
  world(on, new Map(), [])
  mock.env(on, { APPDATA })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const status = textOf(await $.tool.call({ tool: 'mcp__drive-cleanup__get_scan_status' }))
  expect(status).toContain('no completed scan')
  const none = textOf(await $.tool.call({ tool: 'mcp__drive-cleanup__get_findings' }))
  expect(none).toContain('There is no deep scan yet')
})

test('the pane invites a first scan, on every surface', async ($, on) => {
  world(on, new Map(), [])
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'drive-cleanup',
      surface,
      component: 'Pane',
      requestId: 'drive-cleanup',
      props: {
        title: 'Drive Cleanup',
        isFocused: false,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    })
    expect((await ui.find({ type: 'Text', text: /No deep scan yet/ }))?.text).toContain('No deep scan yet')
    expect(await ui.find({ type: 'Button', key: 'run' })).toBeDefined()
    await ui.unmount()
  }
})

const PANE = {
  plugin: 'drive-cleanup',
  component: 'Pane',
  requestId: 'drive-cleanup',
  props: {
    title: 'Drive Cleanup',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('Review without a scan asks for one; Settings start with everything off', async ($, on) => {
  const files: Files = new Map()
  world(on, files, [])
  mock.env(on, { APPDATA })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-review' })
    expect((await ui.find({ type: 'Text', text: /Run a deep scan first/ }))?.text).toContain('Run a deep scan first')
    await ui.press({ key: 'tab-settings' })
    expect((await ui.find({ type: 'Text', text: /Cleanup:/ }))?.text).toContain('off')
    expect((await ui.find({ type: 'Text', text: /Duplicate search/ }))?.text).toContain('off')
    expect(await ui.find({ type: 'Text', text: /Only you can change these/ })).toBeDefined()
    await ui.press({ key: 'tab-overview' })
    await ui.unmount()
  }
})

test('turning cleanup on needs an answer: a dismissed question leaves it off', async ($, on) => {
  const files: Files = new Map()
  world(on, files, [])
  mock.env(on, { APPDATA })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-settings' })
  await ui.press({ key: 'set-cleanup' })
  const saved = [...files.entries()].find(([k]) => k.endsWith('settings.json'))?.[1]
  expect(saved === undefined || !saved.includes('"cleanupEnabled":true')).toBe(true)
  await ui.unmount()
})

test('Claude can read settings and quarantine, never change them', async ($, on) => {
  world(on, new Map(), [])
  mock.env(on, { APPDATA })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(textOf(await $.tool.call({ tool: 'mcp__drive-cleanup__get_settings' }))).toContain('Cleanup off')
  expect(textOf(await $.tool.call({ tool: 'mcp__drive-cleanup__get_quarantine' }))).toContain('No cleanups yet')
  expect(textOf(await $.tool.call({ tool: 'mcp__drive-cleanup__get_dev_caches' }))).toContain(
    'There is no deep scan yet',
  )
})
