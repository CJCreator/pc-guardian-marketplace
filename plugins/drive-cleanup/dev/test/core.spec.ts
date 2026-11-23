// Unit tests for Drive Cleanup's core (pure logic). Run from the repository root:
//   bun test

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { classifyCandidate, classifyScan } from '../../hooks/core/classify.ts'
import { isUnder, normalizePath, protectedBy } from '../../hooks/core/paths.ts'
import { windowsRecommendations } from '../../hooks/core/recommend.ts'
import { buildReports, csv, csvCell } from '../../hooks/core/reports.ts'
import { type Check, parseOutput, RawVolumeCheck, RawWalkCheck, RawWindowsCheck } from '../../hooks/core/validate.ts'
import { candidate, ctx, NOW, PROFILE, volume, walk, windows } from './fixtures.ts'

const PLUGIN = join(import.meta.dirname, '..', '..')

describe('paths', () => {
  it('normalises Windows spellings', () => {
    assert.equal(normalizePath('\\\\?\\C:\\Users\\Asha\\'), 'c:\\users\\asha')
    assert.equal(normalizePath('C:/Users//Asha/Docs. '), 'c:\\users\\asha\\docs')
    assert.equal(normalizePath('C:'), 'c:\\')
    assert.equal(normalizePath('\\\\?\\UNC\\server\\share\\x'), '\\\\server\\share\\x')
  })
  it('isUnder respects segment boundaries', () => {
    assert.ok(isUnder('C:\\Windows\\System32', 'c:\\windows'))
    assert.ok(isUnder('C:\\Windows', 'C:\\Windows\\'))
    assert.ok(!isUnder('C:\\WindowsApps\\x', 'C:\\Windows'))
    assert.ok(isUnder('C:\\anything', 'C:\\'))
  })
})

describe('protected paths (PLAN.md §2.2)', () => {
  const c = ctx()
  const cases: [string, boolean, string][] = [
    ['C:\\Windows\\System32\\drivers\\x.sys', true, 'Windows folder'],
    ['C:\\WINDOWS\\WinSxS\\big.cab', true, 'Windows folder, other case'],
    ['C:\\Program Files\\App\\setup.exe', true, 'Program Files'],
    ['C:\\Program Files (x86)\\App\\a.zip', true, 'Program Files (x86)'],
    ['C:\\ProgramData\\Package Cache\\a.msi', true, 'ProgramData'],
    ['C:\\Users\\Default\\NTUSER.DAT', true, 'Default profile'],
    ['C:\\Users\\Public\\Downloads\\a.exe', true, 'Public profile'],
    ['C:\\Users\\Ravi\\Downloads\\a.exe', true, "another user's profile"],
    ['C:\\hiberfil.sys', true, 'root system file'],
    ['C:\\Recovery\\WindowsRE\\Winre.wim', true, 'Recovery'],
    [`${PROFILE}\\.ssh\\config`, true, '.ssh folder'],
    [`${PROFILE}\\work\\.env`, true, '.env'],
    [`${PROFILE}\\work\\.env.production`, true, '.env.*'],
    [`${PROFILE}\\Downloads\\id_ed25519`, true, 'SSH key'],
    [`${PROFILE}\\Downloads\\server.pfx`, true, 'certificate'],
    [`${PROFILE}\\Documents\\Outlook\\mail.pst`, true, 'mail store'],
    [`${PROFILE}\\Documents\\app.sqlite`, true, 'database'],
    [`${PROFILE}\\Downloads\\credentials.json`, true, 'credentials file'],
    [`${PROFILE}\\src\\shop\\.git\\objects\\pack\\x.pack`, true, 'git data'],
    [`${PROFILE}\\AppData\\Local\\Packages\\Microsoft.X\\a.log`, true, 'Store app data'],
    [`${PROFILE}\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data`, true, 'browser profile'],
    [`${PROFILE}\\AppData\\Roaming\\Code\\User\\settings.json`, true, 'VS Code settings'],
    [`${PROFILE}\\AppData\\Roaming\\Antigravity\\User\\settings.json`, true, 'Antigravity settings'],
    [`${PROFILE}\\AppData\\Local\\Microsoft\\Windows\\UsrClass.dat`, true, 'Windows profile data'],
    [`${PROFILE}\\AppData\\Roaming\\techgramam-drive-cleanup\\scans\\x.json`, true, 'own data'],
    ['D:\\Drive Cleanup Quarantine\\r1\\C\\x.zip', true, 'quarantine'],
    [`${PROFILE}\\Downloads\\setup-old.exe`, false, 'installer in Downloads'],
    [`${PROFILE}\\Documents\\report.pdf`, false, 'document'],
    [`${PROFILE}\\AppData\\Local\\Temp\\7zS1234\\setup.exe`, false, 'Temp'],
    [`${PROFILE}\\AppData\\Local\\Microsoft\\Windows\\INetCache\\IE\\x.dat`, false, 'INetCache exception'],
    ['C:\\Tools\\old.zip', false, 'root user folder'],
  ]
  for (const [path, isProtected, label] of cases) {
    it(`${isProtected ? 'protects' : 'does not protect'}: ${label}`, () => {
      assert.equal(protectedBy(path, c) !== null, isProtected, `${path} → ${String(protectedBy(path, c))}`)
    })
  }
  it('a folder named like a credential file is judged as a folder', () => {
    assert.equal(protectedBy(`${PROFILE}\\Downloads\\credentials-backup`, c, true), null)
  })
})

describe('classification (PLAN.md §5)', () => {
  const c = ctx()
  it('an installer in Downloads is review / quarantine', () => {
    const f = classifyCandidate(candidate({ kind: 'installer', path: `${PROFILE}\\Downloads\\setup.exe` }), c)
    assert.equal(f?.class, 'review')
    assert.equal(f?.action, 'quarantine')
  })
  it('anything in a project is protected, whatever its kind', () => {
    const f = classifyCandidate(
      candidate({ kind: 'archive', path: `${PROFILE}\\src\\app\\dist.zip`, inProject: true }),
      c,
    )
    assert.equal(f?.class, 'protected')
    assert.equal(f?.action, 'none')
  })
  it('a protected location wins over the kind', () => {
    const f = classifyCandidate(candidate({ kind: 'large_old', path: `${PROFILE}\\Documents\\mail.pst` }), c)
    assert.equal(f?.class, 'protected')
  })
  it('an archive with a same-named folder is an extracted pair, low confidence', () => {
    const f = classifyCandidate(
      candidate({
        kind: 'archive',
        path: `${PROFILE}\\Downloads\\tool.zip`,
        extractedFolder: `${PROFILE}\\Downloads\\tool`,
      }),
      c,
    )
    assert.equal(f?.category, 'extracted_pair')
    assert.equal(f?.confidence, 'low')
  })
  it('crash dumps: safe in CrashDumps, review elsewhere', () => {
    const a = classifyCandidate(
      candidate({ kind: 'crash_dump', path: `${PROFILE}\\AppData\\Local\\CrashDumps\\x.dmp` }),
      c,
    )
    const b = classifyCandidate(candidate({ kind: 'crash_dump', path: `${PROFILE}\\Desktop\\debug.dmp` }), c)
    assert.deepEqual([a?.class, a?.action], ['safe', 'delete'])
    assert.deepEqual([b?.class, b?.action], ['review', 'quarantine'])
  })
  it('logs: safe only in a known app log folder, and only when old', () => {
    const known = classifyCandidate(
      candidate({ kind: 'log', path: `${PROFILE}\\AppData\\Roaming\\Zoom\\logs\\zoom.log` }),
      c,
    )
    const unknown = classifyCandidate(
      candidate({ kind: 'log', path: `${PROFILE}\\AppData\\Roaming\\Acme\\data\\x.log` }),
      c,
    )
    const recent = classifyCandidate(
      candidate({
        kind: 'log',
        path: `${PROFILE}\\AppData\\Roaming\\Zoom\\logs\\new.log`,
        modifiedUtc: new Date(NOW - 86_400_000).toISOString(),
      }),
      c,
    )
    assert.equal(known?.class, 'safe')
    assert.equal(unknown?.class, 'review')
    assert.equal(recent, undefined)
  })
  it('Temp folders: safe when old, not listed when recent', () => {
    const old = classifyCandidate(
      candidate({ kind: 'temp_extract', path: `${PROFILE}\\AppData\\Local\\Temp\\7zS01`, isFolder: true }),
      c,
    )
    const recent = classifyCandidate(
      candidate({
        kind: 'temp_extract',
        path: `${PROFILE}\\AppData\\Local\\Temp\\7zS02`,
        isFolder: true,
        modifiedUtc: new Date(NOW).toISOString(),
      }),
      c,
    )
    assert.equal(old?.class, 'safe')
    assert.equal(recent, undefined)
  })
  it('last-access dates are dropped when Windows does not record them', () => {
    const f = classifyCandidate(candidate({ kind: 'old_download', path: `${PROFILE}\\Downloads\\a.pdf` }), c)
    assert.equal(f?.accessedUtc, null)
    const g = classifyCandidate(
      candidate({ kind: 'old_download', path: `${PROFILE}\\Downloads\\a.pdf` }),
      ctx({ lastAccessTrusted: true }),
    )
    assert.notEqual(g?.accessedUtc, null)
  })
  it('Temp files are cleaned here, by the cache script with its 7-day rule, with or without PC Guardian', () => {
    for (const context of [c, ctx({ isPcGuardianInstalled: true })]) {
      const temp = classifyScan({ walk: walk(), windows: null }, context).findings.find(f => f.category === 'user_temp')
      assert.deepEqual([temp?.class, temp?.action, temp?.cacheId], ['safe', 'delete', 'user_temp'])
      assert.match(temp?.reason ?? '', /7 days/)
    }
  })
  it('Windows-managed space is manual; the Recycle Bin is its own cleanable item', () => {
    const scan = classifyScan({ walk: null, windows: windows() }, c)
    const update = scan.findings.find(f => f.evidence.rule === 'windows_update_cache')
    assert.equal(update?.action, 'manual')
    assert.ok(!scan.findings.some(f => f.path.endsWith('hiberfil.sys')))
    const bin = scan.findings.find(f => f.evidence.rule === 'windows_recycle_bin')
    assert.deepEqual(
      [bin?.category, bin?.class, bin?.action, bin?.cacheId],
      ['recycle_bin', 'safe', 'delete', 'recycle_bin'],
    )
    assert.match(bin?.reason ?? '', /for good/)
    assert.equal(scan.recoverable.manualBytes, 3 * 1024 ** 3)
  })
  it('totals add up and mark capped kinds', () => {
    const cands = [
      candidate({ kind: 'installer', path: `${PROFILE}\\Downloads\\a.exe`, bytes: 100 }),
      candidate({ kind: 'installer', path: `${PROFILE}\\Downloads\\b.exe`, bytes: 200 }),
      candidate({ kind: 'installer', path: 'C:\\Program Files\\x\\c.exe', bytes: 50 }),
    ]
    const scan = classifyScan({ walk: walk(cands), windows: null }, c)
    const inst = scan.totals.find(t => t.category === 'installer' && t.class === 'review')
    assert.deepEqual([inst?.count, inst?.bytes, inst?.isCapped], [2, 300, true])
    // Largest first.
    assert.equal(scan.findings[0]?.category, 'user_temp')
  })
  it('a duplicate candidate path is listed once', () => {
    const a = candidate({ kind: 'installer', path: `${PROFILE}\\Downloads\\a.exe` })
    const scan = classifyScan({ walk: walk([a, { ...a, path: a.path.toUpperCase() }]), windows: null }, c)
    assert.equal(scan.findings.filter(f => f.category === 'installer').length, 1)
  })
})

describe('validation of script output', () => {
  it('accepts what the scripts print', () => {
    const cases: [Check<unknown>, unknown][] = [
      [RawVolumeCheck, volume()],
      [RawWalkCheck, walk([candidate({ kind: 'installer', path: 'C:\\x.exe' })])],
      [RawWindowsCheck, windows()],
    ]
    for (const [check, data] of cases) {
      const parsed = parseOutput(check, `\uFEFF${JSON.stringify(data)}\r\n`, 'x.ps1')
      assert.equal(parsed.status, 'ok', JSON.stringify(parsed))
    }
  })
  it('reads a one-item list printed as an object (PowerShell 5.1)', () => {
    const data = { ...volume(), drives: volume().drives[0] }
    const parsed = parseOutput(RawVolumeCheck, JSON.stringify(data), 'volume.ps1')
    assert.equal(parsed.status, 'ok')
    if (parsed.status === 'ok') assert.equal(parsed.data.drives.length, 1)
  })
  it('refuses unknown keys, negative sizes and bad kinds', () => {
    assert.equal(parseOutput(RawVolumeCheck, JSON.stringify({ ...volume(), extra: 1 }), 'v').status, 'not_checked')
    const w = walk()
    assert.equal(
      parseOutput(RawWalkCheck, JSON.stringify({ ...w, totals: { ...w.totals, bytes: -1 } }), 'w').status,
      'not_checked',
    )
    const bad = walk([{ ...candidate({ kind: 'installer', path: 'C:\\x' }), kind: 'everything' as 'installer' }])
    assert.equal(parseOutput(RawWalkCheck, JSON.stringify(bad), 'w').status, 'not_checked')
    assert.equal(parseOutput(RawWalkCheck, 'not json', 'w').status, 'not_checked')
  })
})

describe('reports', () => {
  it('escapes CSV formulas and quotes', () => {
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`)
    assert.equal(csvCell('+1'), `"'+1"`)
    assert.equal(csvCell('plain'), '"plain"')
    assert.equal(csvCell(null), '""')
    const text = csv(['a'], [['1']])
    assert.ok(text.startsWith('\uFEFF'))
    assert.ok(text.includes('\r\n'))
  })
  it('writes the audit files', () => {
    const c = ctx()
    const w = walk([candidate({ kind: 'archive', path: `${PROFILE}\\Downloads\\a|b.zip` })])
    const files = buildReports({
      meta: {
        scanId: 's1',
        createdAt: new Date(NOW).toISOString(),
        finishedAt: new Date(NOW).toISOString(),
        steps: [],
        isPcGuardianInstalled: false,
        dataFolder: c.dataFolder,
      },
      volume: volume(),
      walk: w,
      windows: windows(),
      classified: classifyScan({ walk: w, windows: windows() }, c),
      recommendations: windowsRecommendations(volume(), windows()),
      ctx: c,
    })
    assert.deepEqual(
      files.map(f => f.name),
      [
        'storage_audit.md',
        'largest_files.csv',
        'installers_and_archives.csv',
        'cleanup_recommendations.md',
        'cache_analysis.md',
        'duplicate_files.csv',
      ],
    )
    const largest = files[1]?.text ?? ''
    assert.ok(largest.includes('"C:\\pagefile.sys"') && largest.includes('"protected"'))
    assert.ok(largest.includes(`"${PROFILE}\\Videos\\holiday=1+1.mp4"`))
    const recs = files[3]?.text ?? ''
    assert.ok(recs.includes('a\\|b.zip'), 'pipes in paths are escaped in Markdown tables')
    assert.ok((files[0]?.text ?? '').includes('Not checked'), 'untrusted last-access is reported as Not checked')
  })
})

describe('Windows recommendations (PLAN.md §8)', () => {
  it('suggests Storage Sense, Update cleanup and the hibernation file', () => {
    const ids = new Set(windowsRecommendations(volume(), windows()).map(r => r.id))
    assert.ok(ids.has('storage_sense_off'))
    assert.ok(ids.has('windows_update_cache'))
    assert.ok(ids.has('hibernation_file'))
    assert.ok(!ids.has('low_free_space'))
  })
  it('flags low free space', () => {
    const v = volume()
    const d = v.drives[0]
    assert.ok(d !== undefined)
    const ids = windowsRecommendations({ ...v, drives: [{ ...d, freeBytes: 5 * 1024 ** 3 }] }, null).map(r => r.id)
    assert.ok(ids.includes('low_free_space'))
  })
})

describe('scan scripts (S1, S3)', () => {
  const dir = join(PLUGIN, 'ps', 'scan')
  const scripts = readdirSync(dir).filter(f => f.endsWith('.ps1'))
  it('there are scan scripts', () => assert.ok(scripts.length >= 3))
  for (const file of scripts) {
    it(`${file} has no command or API that writes, moves or deletes`, () => {
      const text = readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter(line => !line.trim().startsWith('#'))
        .join('\n')
      const forbidden = [
        /Remove-Item/i,
        /Move-Item/i,
        /Copy-Item/i,
        /Rename-Item/i,
        /New-Item/i,
        /Set-Content/i,
        /Add-Content/i,
        /Out-File/i,
        /Set-ItemProperty/i,
        /New-ItemProperty/i,
        /Remove-ItemProperty/i,
        /Clear-/i,
        /Stop-Process/i,
        /Start-Process/i,
        /Invoke-Expression/i,
        /\biex\b/i,
        /\.Delete\(/,
        /\.MoveTo\(/,
        /\.CopyTo\(/,
        /\.Create\(/,
        /WriteAll/,
        /\.OpenWrite\(/,
        /\.Open\(/,
        /File\]::Open/,
        /\s>>?\s/,
        /Set-Acl/i,
        /Invoke-WebRequest/i,
        /Net\.WebClient/i,
      ]
      for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${file} matches ${String(pattern)}`)
    })
  }
  it('recorded fingerprints match the scripts', async () => {
    const { SCRIPT_HASHES } = await import('../../hooks/script-hashes.ts')
    const { normalizeScriptText, sha256Hex, SCRIPTS } = await import('../../hooks/core/scripts.ts')
    for (const spec of Object.values(SCRIPTS)) {
      const text = readFileSync(join(PLUGIN, 'ps', ...spec.file.split('/')), 'utf8')
      assert.equal(await sha256Hex(normalizeScriptText(text)), SCRIPT_HASHES[spec.file], spec.file)
    }
  })
})

describe('advice and totals (1.7)', () => {
  it('points Windows Update downloads and dumps to the administrator tasks, and restore points to Settings', () => {
    const recs = windowsRecommendations(volume(), windows())
    const text = JSON.stringify(recs)
    assert.doesNotMatch(text, /Tick \\"Windows Update Cleanup\\"/)
    assert.doesNotMatch(text, /Control Panel > System/)
    assert.doesNotMatch(text, /class A|class B/)
  })
  it('suggests uninstalling apps when Program Files is big', () => {
    const w = { ...walk(), protectedRoots: [{ path: 'C:\\Program Files', bytes: 60 * 1024 ** 3, fileCount: 1 }] }
    assert.ok(windowsRecommendations(volume(), windows(), w).some(r => r.id === 'installed_apps'))
  })
})
