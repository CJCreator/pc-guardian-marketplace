// Unit tests for M2–M5: developer caches, leftovers, duplicates, approval
// planning, the action scripts' guards, run records and the final report.
//   bun test   (from the repository root)

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { classifyCandidate, classifyScan } from '../../hooks/core/classify.ts'
import { BROWSER_CACHES, CLEANABLE_CACHE_IDS, DEV_CACHES, SAFE_CACHE_IDS } from '../../hooks/core/devcaches.ts'
import { chooseKeeper, duplicateFindings, mergeHash } from '../../hooks/core/duplicates.ts'
import { protectedBy } from '../../hooks/core/paths.ts'
import { chooseQuarantineRoot, planCleanup, type PlanInput } from '../../hooks/core/plan.ts'
import {
  bootstrapScript,
  checkLaunch,
  checkTasks,
  ELEVATED_TASK_IDS,
  elevatedEstimate,
  elevatedSummary,
  quote,
  encodeCommand,
  estimateBytes,
  launcherScript,
  type ElevatedLaunch,
} from '../../hooks/core/elevated.ts'
import {
  answers,
  freedEstimate,
  isActionable,
  MAX_PROPOSAL_ITEMS,
  proposalQuestion,
  selectForProposal,
} from '../../hooks/core/propose.ts'
import { finalReport } from '../../hooks/core/reports.ts'
import { indexEntry, manifestRows, runSummaryText } from '../../hooks/core/runs.ts'
import { ACTIONS, checkParams, SCRIPTS } from '../../hooks/core/scripts.ts'
import {
  DEFAULT_SETTINGS,
  type Finding,
  type RawDevCaches,
  type RawHash,
  type RunRecord,
} from '../../hooks/core/types.ts'
import {
  parseOutput,
  RawApplyCheck,
  RawCacheCleanCheck,
  RawDevCachesCheck,
  RawHashCheck,
  RawLeftoversCheck,
  RawPurgeCheck,
  RawVerifyCheck,
} from '../../hooks/core/validate.ts'
import { parseSettings } from '../../hooks/settings-store.ts'
import { candidate, ctx, NOW, PROFILE, volume, walk, windows } from './fixtures.ts'
import { otherDrive } from '../../hooks/core/space.ts'
import { RawVolumeCheck as VolumeCheck, RawWalkCheck } from '../../hooks/core/validate.ts'

const PLUGIN = join(import.meta.dirname, '..', '..')
const ps = (rel: string): string => readFileSync(join(PLUGIN, 'ps', ...rel.split('/')), 'utf8')
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * 86_400_000).toISOString()

const devcaches = (): RawDevCaches => ({
  caches: [
    {
      id: 'npm_cache',
      isPresent: true,
      bytes: 2 * 1024 ** 3,
      fileCount: 9000,
      lastWriteUtc: iso(3),
      isRunning: false,
      isTruncated: false,
      roots: [
        {
          path: `${PROFILE}\\AppData\\Local\\npm-cache\\_cacache`,
          status: 'ok',
          bytes: 2 * 1024 ** 3,
          fileCount: 9000,
        },
      ],
    },
    {
      id: 'vscode_cache',
      isPresent: true,
      bytes: 500 * 1024 ** 2,
      fileCount: 300,
      lastWriteUtc: iso(1),
      isRunning: true,
      isTruncated: false,
      roots: [
        { path: `${PROFILE}\\AppData\\Roaming\\Code\\Cache`, status: 'ok', bytes: 500 * 1024 ** 2, fileCount: 300 },
        { path: `${PROFILE}\\AppData\\Roaming\\Code\\logs`, status: 'ok', bytes: 1, fileCount: 1 },
      ],
    },
    {
      id: 'maven_repo',
      isPresent: true,
      bytes: 3 * 1024 ** 3,
      fileCount: 40000,
      lastWriteUtc: iso(30),
      isRunning: false,
      isTruncated: false,
      roots: [{ path: `${PROFILE}\\.m2\\repository`, status: 'ok', bytes: 3 * 1024 ** 3, fileCount: 40000 }],
    },
    {
      id: 'pip_cache',
      isPresent: false,
      bytes: 0,
      fileCount: 0,
      lastWriteUtc: null,
      isRunning: false,
      isTruncated: false,
      roots: [{ path: `${PROFILE}\\AppData\\Local\\pip\\cache`, status: 'missing', bytes: 0, fileCount: 0 }],
    },
  ],
})

const hash = (): RawHash => ({
  elapsedMs: 1000,
  isTruncated: false,
  resumeBelowBytes: null,
  filesConsidered: 10,
  filesHashed: 6,
  bytesHashed: 6e9,
  skippedLocked: 0,
  skippedCloud: 2,
  groups: [
    {
      sha256: 'a'.repeat(64),
      bytes: 1024 ** 3,
      files: [
        {
          path: `${PROFILE}\\Downloads\\movie (1).mp4`,
          modifiedUtc: iso(10),
          accessedUtc: iso(10),
          createdUtc: iso(10),
        },
        { path: `${PROFILE}\\Videos\\movie.mp4`, modifiedUtc: iso(100), accessedUtc: iso(100), createdUtc: iso(100) },
        { path: `${PROFILE}\\Desktop\\movie - Copy.mp4`, modifiedUtc: iso(5), accessedUtc: iso(5), createdUtc: iso(5) },
      ],
    },
  ],
  folderGroups: [
    {
      signature: 'b'.repeat(64),
      bytes: 500 * 1024 ** 2,
      fileCount: 20,
      folders: [`${PROFILE}\\Pictures\\Trip`, `${PROFILE}\\Downloads\\Trip`],
    },
    {
      signature: 'c'.repeat(64),
      bytes: 100 * 1024 ** 2,
      fileCount: 5,
      folders: [`${PROFILE}\\Pictures\\Trip\\Day1`, `${PROFILE}\\Downloads\\Trip\\Day1`],
    },
  ],
})

describe('developer caches (M2)', () => {
  it('the TS table, the scan script and the clean script agree on ids', () => {
    const scanIds = [...ps('scan/dev-caches.ps1').matchAll(/id = '([a-z_]+)'/g)].map(m => m[1]).toSorted()
    assert.deepEqual(scanIds, DEV_CACHES.map(c => c.id).toSorted())
    const cleanIds = [...ps('actions/clean-cache.ps1').matchAll(/^\s{4}([a-z_]+)\s+= @\{ roots/gm)]
      .map(m => m[1])
      .toSorted()
    assert.deepEqual(
      cleanIds,
      [...CLEANABLE_CACHE_IDS].toSorted(),
      'clean-cache.ps1 knows exactly the class A caches, Temp and the Recycle Bin',
    )
    assert.ok(SAFE_CACHE_IDS.every(id => CLEANABLE_CACHE_IDS.includes(id)))
  })
  it('class A caches can be cleaned, class B are manual, absent ones are not listed', () => {
    const scan = classifyScan({ walk: null, windows: null, devcaches: devcaches() }, ctx())
    const npm = scan.findings.find(f => f.cacheId === 'npm_cache')
    const maven = scan.findings.find(f => f.cacheId === 'maven_repo')
    assert.deepEqual([npm?.class, npm?.action], ['safe', 'delete'])
    assert.deepEqual([maven?.class, maven?.action], ['review', 'manual'])
    assert.equal(
      scan.findings.find(f => f.cacheId === 'pip_cache'),
      undefined,
    )
    const code = scan.findings.find(f => f.cacheId === 'vscode_cache')
    assert.match(code?.reason ?? '', /running now/)
    assert.equal(code?.protectedBy, null, "VS Code's cache folders are not protected")
  })
  it('browser profiles stay protected except their cache folders', () => {
    const c = ctx()
    const edge = `${PROFILE}\\AppData\\Local\\Microsoft\\Edge\\User Data`
    for (const cache of [
      `${edge}\\Default\\Cache\\Cache_Data`,
      `${edge}\\Profile 2\\Code Cache`,
      `${edge}\\Default\\GPUCache\\data_0`,
      `${PROFILE}\\AppData\\Local\\Mozilla\\Firefox\\Profiles\\ab12.default\\cache2`,
    ])
      assert.equal(protectedBy(cache, c, true), null, cache)
    for (const kept of [
      edge,
      `${edge}\\Default`,
      `${edge}\\Default\\History`,
      `${edge}\\Default\\Login Data`,
      `${edge}\\Default\\Cache`,
      `${edge}\\Default\\Network\\Cookies`,
      `${edge}\\System Profile\\Cache\\Cache_Data`,
      `${PROFILE}\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\ab12.default\\places.sqlite`,
    ])
      assert.equal(protectedBy(kept, c, false), 'Browser profile', kept)
  })
  it('browser caches are their own category, cleaned while the browser is closed', () => {
    assert.deepEqual(
      BROWSER_CACHES.map(b => b.id),
      ['edge_cache', 'chrome_cache', 'brave_cache', 'firefox_cache'],
    )
    const scanText = ps('scan/dev-caches.ps1')
    const cleanText = ps('actions/clean-cache.ps1')
    for (const [id, owner] of [
      ['edge_cache', 'msedge'],
      ['chrome_cache', 'chrome'],
      ['brave_cache', 'brave'],
      ['firefox_cache', 'firefox'],
    ]) {
      assert.match(scanText, new RegExp(`id = '${id}'.*owners = @\\('${owner}'\\)`), id)
      assert.match(cleanText, new RegExp(`${id}\\s+= @\\{.*owners = @\\('${owner}'\\)`), id)
    }
    for (const text of [scanText, cleanText]) {
      assert.match(text, /'Cache\\Cache_Data', 'Code Cache', 'GPUCache'/)
      assert.match(text, /'cache2'/)
    }
    const raw = {
      caches: [
        {
          id: 'chrome_cache',
          isPresent: true,
          bytes: 900 * 1024 ** 2,
          fileCount: 4000,
          lastWriteUtc: new Date(NOW).toISOString(),
          isRunning: false,
          isTruncated: false,
          roots: [
            {
              path: `${PROFILE}\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\Cache_Data`,
              status: 'ok' as const,
              bytes: 900 * 1024 ** 2,
              fileCount: 4000,
            },
            {
              path: `${PROFILE}\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Code Cache`,
              status: 'missing' as const,
              bytes: 0,
              fileCount: 0,
            },
          ],
        },
      ],
    }
    const f = classifyScan({ walk: null, windows: null, devcaches: raw }, ctx()).findings[0]
    assert.deepEqual(
      [f?.category, f?.class, f?.action, f?.cacheId],
      ['browser_cache', 'safe', 'delete', 'chrome_cache'],
    )
    assert.equal(protectedBy(f?.path ?? '', ctx(), true), null, 'its path is a cache folder, not the profile')
  })
  it('the Recycle Bin is only ever chosen by name, and the question says it is for good', () => {
    const win = classifyScan({ walk: null, windows: windows() }, ctx()).findings
    const bin = win.find(f => f.category === 'recycle_bin') as Finding
    const bySafe = selectForProposal(win, { classes: ['safe'] })
    assert.ok(bySafe.status === 'refused' || !bySafe.ids.includes(bin.id), 'classes: safe never takes the Recycle Bin')
    const named = selectForProposal(win, { categories: ['recycle_bin'] }) as { ids: string[] }
    assert.deepEqual(named.ids, [bin.id])
    const q = proposalQuestion({
      findings: win,
      ids: named.ids,
      plan: { deleteBytes: bin.bytes, quarantineBytes: 0, quarantineRoot: '', systemDrive: 'C:' },
      isCleanupOn: true,
    })
    assert.match(q, /Empty the Recycle Bin \(.+\)\. Those files are gone for good\./)
    assert.doesNotMatch(q, /caches and temporary files/, 'not described as caches')
  })
  it('the Recycle Bin is emptied only for items deleted before the approval, and Temp keeps its 7 days', () => {
    const text = ps('actions/clean-cache.ps1')
    assert.match(text, /GetFiles\('\$I\*'\)/)
    assert.match(text, /\$record\.LastWriteTimeUtc -gt \$approvedAt/)
    assert.doesNotMatch(text.replaceAll(/#.*$/gm, ''), /Clear-RecycleBin/, 'never empties every drive at once')
    assert.match(text, /user_temp\s+= @\{.*olderThanDays = 7/)
    assert.match(text, /LastWriteTimeUtc -gt \$cutoff/)
  })
  it('editor settings stay protected while its caches are not', () => {
    assert.notEqual(protectedBy(`${PROFILE}\\AppData\\Roaming\\Code\\User\\settings.json`, ctx()), null)
    assert.equal(protectedBy(`${PROFILE}\\AppData\\Roaming\\Code\\CachedData\\x`, ctx()), null)
    assert.equal(protectedBy(`${PROFILE}\\AppData\\Roaming\\Antigravity\\logs\\a.log`, ctx()), null)
  })
  it('a build cache inside a project is offered, other project files are not', () => {
    const cache = classifyCandidate(
      candidate({ kind: 'build_cache', path: `${PROFILE}\\src\\shop\\.next\\cache`, isFolder: true, inProject: true }),
      ctx(),
    )
    const other = classifyCandidate(
      candidate({ kind: 'large_old', path: `${PROFILE}\\src\\shop\\data.bin`, inProject: true }),
      ctx(),
    )
    assert.deepEqual([cache?.category, cache?.action], ['build_cache', 'quarantine'])
    assert.equal(other?.class, 'protected')
  })
  it('leftovers are low-confidence review items; protected ones stay protected', () => {
    const scan = classifyScan(
      {
        walk: null,
        windows: null,
        leftovers: {
          installedCount: 120,
          folders: [
            {
              path: `${PROFILE}\\AppData\\Roaming\\OldTool`,
              bytes: 300 * 1024 ** 2,
              fileCount: 10,
              lastWriteUtc: iso(700),
              isTruncated: false,
            },
            {
              path: `${PROFILE}\\AppData\\Local\\Packages\\X`,
              bytes: 300 * 1024 ** 2,
              fileCount: 10,
              lastWriteUtc: iso(700),
              isTruncated: false,
            },
          ],
        },
      },
      ctx(),
    )
    const [a, b] = [
      scan.findings.find(f => f.path.endsWith('OldTool')),
      scan.findings.find(f => f.path.endsWith('\\X')),
    ]
    assert.deepEqual([a?.category, a?.confidence, a?.action], ['leftover', 'low', 'quarantine'])
    assert.equal(b?.class, 'protected')
  })
})

describe('duplicates (M3)', () => {
  it('keeps the copy in a preferred folder with the original name', () => {
    const k = chooseKeeper(hash().groups[0]?.files ?? [], ctx())
    assert.equal(k.index, 1)
    assert.match(k.reason, /Documents, Pictures, Videos/)
  })
  it('the keeper is never offered; the others are review / quarantine with the hash', () => {
    const found = duplicateFindings(hash(), ctx()).filter(f => f.category === 'duplicate')
    assert.equal(found.length, 3)
    const keeper = found.filter(f => f.duplicate?.isSuggestedKeeper)
    assert.equal(keeper.length, 1)
    assert.equal(keeper[0]?.action, 'none')
    assert.ok(
      found
        .filter(f => !f.duplicate?.isSuggestedKeeper)
        .every(f => f.action === 'quarantine' && f.duplicate?.sha256 === 'a'.repeat(64)),
    )
  })
  it('nested duplicate folders are reported once, at the top', () => {
    const folders = duplicateFindings(hash(), ctx()).filter(f => f.category === 'duplicate_folder')
    assert.equal(folders.length, 2)
    assert.ok(folders.every(f => f.path.endsWith('Trip')))
  })
  it('a duplicate is not listed again as an old download', () => {
    const scan = classifyScan({ walk: null, windows: null, hash: hash() }, ctx())
    const recoverable = scan.recoverable.reviewBytes
    assert.equal(
      recoverable,
      2 * 1024 ** 3 + 500 * 1024 ** 2,
      'two copies of the file and one folder; keepers not counted',
    )
  })
  it('a resumed search merges into the previous one', () => {
    const a = { ...hash(), isTruncated: true, resumeBelowBytes: 1e9 }
    const b = {
      ...hash(),
      groups: [{ ...(hash().groups[0] as RawHash['groups'][number]), sha256: 'd'.repeat(64) }],
      isTruncated: false,
      resumeBelowBytes: null,
    }
    const m = mergeHash(a, b)
    assert.equal(m.groups.length, 2)
    assert.equal(m.isTruncated, false)
    assert.equal(m.filesHashed, 12)
  })
})

const findingsForPlan = (): Finding[] =>
  classifyScan(
    {
      walk: null,
      windows: null,
      devcaches: devcaches(),
      hash: hash(),
    },
    ctx(),
  ).findings

const planInput = (over: Partial<PlanInput> = {}): PlanInput => ({
  runId: '11111111-2222-3333-4444-555555555555',
  scanId: 's1',
  scanFinishedAt: new Date(NOW - 3_600_000).toISOString(),
  findings: findingsForPlan(),
  selectedIds: [],
  settings: { ...DEFAULT_SETTINGS, cleanupEnabled: true },
  volume: volume({
    drives: [
      {
        letter: 'C:',
        label: 'OS',
        fileSystem: 'NTFS',
        totalBytes: 512 * 1024 ** 3,
        freeBytes: 80 * 1024 ** 3,
        isSystem: true,
        mediaType: 4,
        healthStatus: 'Healthy',
      },
      {
        letter: 'D:',
        label: 'Data',
        fileSystem: 'NTFS',
        totalBytes: 1024 ** 4,
        freeBytes: 600 * 1024 ** 3,
        isSystem: false,
        mediaType: 3,
        healthStatus: 'Healthy',
      },
    ],
  }),
  nowMs: NOW,
  isScanRunning: false,
  ...over,
})

describe('approval planning (M4)', () => {
  const fs = findingsForPlan()
  const dupes = fs.filter(f => f.category === 'duplicate' && f.action === 'quarantine')
  const npm = fs.find(f => f.cacheId === 'npm_cache') as Finding
  const maven = fs.find(f => f.cacheId === 'maven_repo') as Finding

  it('refuses while cleanup is off, a scan runs, or the scan is old', () => {
    assert.match(
      String(
        (planCleanup(planInput({ settings: DEFAULT_SETTINGS, selectedIds: [npm.id] })) as { message: string }).message,
      ),
      /Cleanup is off/,
    )
    assert.equal(planCleanup(planInput({ isScanRunning: true, selectedIds: [npm.id] })).status, 'refused')
    assert.equal(
      planCleanup(planInput({ scanFinishedAt: new Date(NOW - 25 * 3_600_000).toISOString(), selectedIds: [npm.id] }))
        .status,
      'refused',
    )
    assert.equal(planCleanup(planInput({ selectedIds: [] })).status, 'refused')
  })
  it('refuses unknown, protected, manual and keeper items', () => {
    const keeper = fs.find(f => f.duplicate?.isSuggestedKeeper === true) as Finding
    for (const id of ['nope', maven.id, keeper.id]) {
      assert.equal(planCleanup(planInput({ selectedIds: [id] })).status, 'refused', id)
    }
    const prot: Finding = { ...npm, id: 'p', class: 'protected', protectedBy: 'x' }
    assert.equal(planCleanup(planInput({ findings: [...fs, prot], selectedIds: ['p'] })).status, 'refused')
  })
  it('never every copy of a duplicate group', () => {
    const everyCopy = fs
      .filter(f => f.duplicate?.groupId === dupes[0]?.duplicate?.groupId)
      // oxlint-disable-next-line oxc/no-map-spread -- copies, so the shared fixture findings stay unchanged
      .map(f => ({ ...f, action: 'quarantine' as const }))
    const altered = [...fs.filter(f => !everyCopy.some(c => c.id === f.id)), ...everyCopy]
    assert.match(
      String(
        (planCleanup(planInput({ findings: altered, selectedIds: everyCopy.map(f => f.id) })) as { message: string })
          .message,
      ),
      /Keep at least one/,
    )
  })
  it('plans caches as jobs, files as items, with the hash and a quarantine on another drive', () => {
    const plan = planCleanup(planInput({ selectedIds: [npm.id, ...dupes.map(d => d.id)] }))
    assert.equal(plan.status, 'ok')
    if (plan.status !== 'ok') return
    assert.deepEqual(
      plan.caches.map(c => c.cacheId),
      ['npm_cache'],
    )
    assert.equal(plan.list.items.length, 2)
    assert.ok(plan.list.items.every(i => i.action === 'quarantine' && i.sha256 === 'a'.repeat(64)))
    assert.equal(plan.list.quarantineRoot, 'D:\\Drive Cleanup Quarantine')
    assert.match(plan.summary, /restorable/)
  })
  it('chooses a quarantine drive with room, else the system drive, else refuses', () => {
    const v = planInput().volume
    assert.deepEqual(chooseQuarantineRoot(v, 'auto', 10 * 1024 ** 3), {
      status: 'ok',
      root: 'D:\\Drive Cleanup Quarantine',
      drive: 'D:',
    })
    const full = volume({
      drives: [
        {
          letter: 'C:',
          label: '',
          fileSystem: 'NTFS',
          totalBytes: 100 * 1024 ** 3,
          freeBytes: 30 * 1024 ** 3,
          isSystem: true,
          mediaType: 4,
          healthStatus: null,
        },
        {
          letter: 'D:',
          label: '',
          fileSystem: 'NTFS',
          totalBytes: 100 * 1024 ** 3,
          freeBytes: 12 * 1024 ** 3,
          isSystem: false,
          mediaType: 4,
          healthStatus: null,
        },
      ],
    })
    const r = chooseQuarantineRoot(full, 'auto', 5 * 1024 ** 3)
    assert.deepEqual(
      r,
      { status: 'ok', root: 'C:\\Drive Cleanup Quarantine', drive: 'C:' },
      'D: would drop under 10 GB; C: renames in place',
    )
    assert.equal(chooseQuarantineRoot(full, 'D:', 5 * 1024 ** 3).status, 'refused')
    assert.equal(chooseQuarantineRoot(full, 'E:', 1).status, 'refused')
    const fat = volume({
      drives: [
        {
          letter: 'E:',
          label: '',
          fileSystem: 'exFAT',
          totalBytes: 1e12,
          freeBytes: 9e11,
          isSystem: false,
          mediaType: null,
          healthStatus: null,
        },
      ],
    })
    assert.equal(chooseQuarantineRoot(fat, 'auto', 1).status, 'refused', 'never a non-NTFS (removable-style) drive')
  })
})

describe('action inputs and scripts (M4)', () => {
  it('inputs are checked strictly', () => {
    assert.equal(checkParams(ACTIONS.apply, { DC_RUN_ID: '11111111-2222-3333-4444-555555555555' }).status, 'ok')
    assert.equal(checkParams(ACTIONS.apply, { DC_RUN_ID: '../../evil' }).status, 'refused')
    assert.equal(
      checkParams(ACTIONS.apply, { DC_RUN_ID: '11111111-2222-3333-4444-555555555555', X: '1' }).status,
      'refused',
    )
    assert.equal(
      checkParams(ACTIONS.cleanCache, { DC_CACHE_ID: 'npm_cache; rm', DC_APPROVED_AT: '2026-10-31T00:00:00.000Z' })
        .status,
      'refused',
    )
    assert.equal(
      checkParams(ACTIONS.purge, {
        DC_RUN_ID: '11111111-2222-3333-4444-555555555555',
        DC_QUARANTINE_ROOT: 'C:\\Windows',
      }).status,
      'refused',
    )
    assert.equal(
      checkParams(SCRIPTS.hash, { DC_MIN_BYTES: '1048576', DC_MAX_BYTES: '4294967296', DC_RESUME_BELOW: '0' }).status,
      'ok',
    )
    assert.equal(checkParams(SCRIPTS.volume, { DC_X: '1' }).status, 'refused')
  })
  it('every action script refuses stale or foreign input before changing anything', () => {
    const apply = ps('actions/apply.ps1')
    assert.match(apply, /\$age -gt 15/)
    assert.match(apply, /Get-ProtectedReason/)
    assert.match(apply, /It changed since the scan/)
    assert.match(apply, /Drive Cleanup Quarantine\$/)
    const code = apply
      .split('\n')
      .filter(l => !l.trim().startsWith('#'))
      .join('\n')
    assert.doesNotMatch(
      code,
      /Clear-RecycleBin|Remove-Item|Shell\.Application|FileSystem\]::Delete/i,
      'never the Recycle Bin, never a recursive Remove-Item',
    )
    for (const f of ['actions/restore.ps1', 'actions/purge.ps1']) assert.match(ps(f), /restore\.json/)
    assert.match(ps('actions/clean-cache.ps1'), /Get-Process -Name \$owner/)
  })
  it('the scan scripts that read contents open files for reading only', () => {
    for (const f of readdirSync(join(PLUGIN, 'ps', 'scan'))) {
      const text = ps(`scan/${f}`)
      assert.doesNotMatch(text, /FileAccess\]::(Write|ReadWrite)/, f)
      assert.doesNotMatch(text, /WriteAllText|AppendAllText|::Delete\(|::Move\(|::Copy\(/, f)
    }
  })
  it('the guard protects the same project markers as the scan, without .vscode', () => {
    for (const f of ['scan/walk.ps1', 'scan/hash.ps1', 'actions/apply.ps1']) {
      const text = ps(f)
      assert.match(text, /'\.git', 'package\.json'/, f)
      assert.doesNotMatch(text, /'\.vscode', '\.idea'/, f)
    }
  })
})

describe('validation of M2–M5 output', () => {
  it('accepts well-formed output and refusals', () => {
    assert.equal(parseOutput(RawDevCachesCheck, JSON.stringify(devcaches()), 'x').status, 'ok')
    assert.equal(parseOutput(RawHashCheck, JSON.stringify(hash()), 'x').status, 'ok')
    assert.equal(parseOutput(RawLeftoversCheck, JSON.stringify({ installedCount: 3, folders: [] }), 'x').status, 'ok')
    assert.equal(
      parseOutput(
        RawVerifyCheck,
        JSON.stringify({
          isElevated: false,
          tools: [{ id: 'git', status: 'ok', version: '2.45' }],
          projects: [],
          quarantine: [],
        }),
        'x',
      ).status,
      'ok',
    )
    assert.equal(
      parseOutput(RawApplyCheck, JSON.stringify({ status: 'refused', reason: 'stale', detail: 'old' }), 'x').status,
      'ok',
    )
    const ok = {
      status: 'ok',
      runId: 'r',
      quarantineDir: null,
      deletedBytes: 1,
      quarantinedBytes: 0,
      isTruncated: false,
      items: { id: 'a', status: 'deleted', detail: '', destination: null, sha256: null, bytes: 1 },
    }
    const parsed = parseOutput(RawApplyCheck, JSON.stringify(ok), 'x')
    assert.equal(parsed.status, 'ok', JSON.stringify(parsed))
    assert.equal(
      parseOutput(
        RawCacheCleanCheck,
        JSON.stringify({ status: 'ok', removedCount: 1, removedBytes: 2, skippedCount: 0 }),
        'x',
      ).status,
      'ok',
    )
    assert.equal(
      parseOutput(
        RawPurgeCheck,
        JSON.stringify({ status: 'ok', runId: 'r', removedCount: 1, removedBytes: 2, failedCount: 0 }),
        'x',
      ).status,
      'ok',
    )
  })
  it('refuses a bad hash and an unknown item status', () => {
    const bad = hash()
    const g = bad.groups[0]
    if (g !== undefined) g.sha256 = 'not-a-hash'
    assert.equal(parseOutput(RawHashCheck, JSON.stringify(bad), 'x').status, 'not_checked')
    const item = {
      status: 'ok',
      runId: 'r',
      quarantineDir: null,
      deletedBytes: 1,
      quarantinedBytes: 0,
      isTruncated: false,
      items: [{ id: 'a', status: 'wiped', detail: '', destination: null, sha256: null, bytes: 1 }],
    }
    assert.equal(parseOutput(RawApplyCheck, JSON.stringify(item), 'x').status, 'not_checked')
  })
})

describe('settings, runs and reports (M4–M5)', () => {
  it('settings default to off and ignore bad values', () => {
    assert.deepEqual(parseSettings(undefined), DEFAULT_SETTINGS)
    assert.deepEqual(parseSettings('not json'), DEFAULT_SETTINGS)
    const s = parseSettings(
      JSON.stringify({
        cleanupEnabled: 'yes',
        duplicatesEnabled: true,
        quarantineDrive: 'C:\\x',
        minDuplicateBytes: -1,
      }),
    )
    assert.deepEqual(
      [s.cleanupEnabled, s.duplicatesEnabled, s.quarantineDrive, s.minDuplicateBytes],
      [false, true, 'auto', DEFAULT_SETTINGS.minDuplicateBytes],
    )
  })
  const record: RunRecord = {
    runId: 'r1',
    kind: 'cleanup',
    scanId: 's1',
    startedAt: '2026-10-31T10:00:00.000Z',
    finishedAt: '2026-10-31T10:01:00.000Z',
    quarantineRoot: 'D:\\Drive Cleanup Quarantine',
    quarantineDir: 'D:\\Drive Cleanup Quarantine\\r1',
    deletedBytes: 2 * 1024 ** 3,
    quarantinedBytes: 1024 ** 3,
    restoredBytes: 0,
    purgedBytes: 0,
    counts: { done: 2, skipped: 1 },
    items: [
      {
        id: 'a',
        status: 'quarantined',
        detail: '',
        destination: 'D:\\Drive Cleanup Quarantine\\r1\\C\\x.exe',
        sha256: 'a'.repeat(64),
        bytes: 1024 ** 3,
        path: 'C:\\x.exe',
        category: 'installer',
        reason: '=cmd|calc',
        action: 'quarantine',
      },
      {
        id: 'b',
        status: 'skipped',
        detail: 'It is in use.',
        destination: null,
        sha256: null,
        bytes: 0,
        path: 'C:\\y.log',
        category: 'app_logs',
        reason: 'old',
        action: 'delete',
      },
    ],
    messages: [],
  }
  it('manifest rows carry every column, escaped', () => {
    const rows = manifestRows(record)
    assert.equal(rows.split('\r\n').length, 3)
    assert.ok(rows.includes(`"'=cmd|calc"`), 'formula escaped')
    assert.ok(rows.includes('"quarantined"') && rows.includes('"It is in use."'))
  })
  it('index entries and summaries', () => {
    assert.equal(indexEntry(record).quarantineState, 'active')
    assert.equal(
      runSummaryText(record),
      'Deleted 2.0 GB of caches and temporary files, moved 1.0 GB of your files to quarantine. 1 item was left alone (in use, changed since the scan, or protected).',
    )
  })
  it('the final report states space, checks and what was not checked', () => {
    const text = finalReport({
      at: '2026-10-31T11:00:00.000Z',
      scanId: 's1',
      freeBeforeBytes: 10 * 1024 ** 3,
      freeAfterBytes: 13 * 1024 ** 3,
      reportedFreedBytes: 3 * 1024 ** 3,
      quarantinedOnSystemDriveBytes: 0,
      verify: {
        isElevated: false,
        tools: [
          { id: 'git', status: 'ok', version: '2.45.1' },
          { id: 'antigravity', status: 'not_found', version: '' },
        ],
        projects: [{ path: `${PROFILE}\\src\\shop`, exists: true, hasGit: true }],
        quarantine: [{ runId: 'r1', checked: 2, matched: 1, missing: 0, mismatched: 1 }],
      },
      verifyDetail: null,
      runs: [{ runId: 'r1', kind: 'cleanup', startedAt: record.startedAt, summary: runSummaryText(record) }],
    })
    assert.match(text, /Difference: 3\.0 GB/)
    assert.match(text, /\*\*1 changed\*\*/)
    assert.match(text, /sfc \/verifyonly/)
    assert.match(text, /not on PATH/)
  })
})

describe('one-confirm proposals (§19)', () => {
  const fs = findingsForPlan()
  const npm = fs.find(f => f.cacheId === 'npm_cache') as Finding
  const keeper = fs.find(f => f.duplicate?.isSuggestedKeeper === true) as Finding
  const copies = fs.filter(f => f.duplicate !== undefined && f.duplicate.isSuggestedKeeper !== true)

  it('needs ids or filters; takes the union of both', () => {
    assert.equal(selectForProposal(fs, {}).status, 'refused')
    const dupe = copies[0] as Finding
    const both = selectForProposal(fs, { findingIds: [dupe.id], classes: ['safe'] }) as {
      status: string
      ids: string[]
    }
    assert.equal(both.status, 'ok')
    assert.ok(both.ids.includes(dupe.id) && both.ids.includes(npm.id), 'named items plus every safe item')
  })
  it('a target counts only what frees the system drive, re-creatable data first', () => {
    const dupe = copies[0] as Finding
    const other = copies.find(c => c.id !== dupe.id)
    const sel = selectForProposal(
      fs,
      { findingIds: [dupe.id], classes: ['safe', 'review'], maxBytes: 1024 ** 4 },
      { quarantineFreesSpace: false },
    ) as { ids: string[] }
    assert.ok(sel.ids.includes(dupe.id), 'a named move stays')
    if (other !== undefined) assert.ok(!sel.ids.includes(other.id), 'moves matched by a filter add nothing on C:')
    assert.equal(
      sel.ids[0],
      fs.filter(f => f.action === 'delete' && isActionable(f)).toSorted((a, b) => b.bytes - a.bytes)[0]?.id,
    )
  })
  it('refuses the whole proposal when a named item is protected, a keeper or unknown', () => {
    const prot: Finding = { ...npm, id: 'p', class: 'protected', protectedBy: 'Windows folder' }
    assert.match(
      (selectForProposal([...fs, prot], { findingIds: [npm.id, 'p'] }) as { message: string }).message,
      /protected/,
    )
    assert.match((selectForProposal(fs, { findingIds: [keeper.id] }) as { message: string }).message, /copy to keep/)
    assert.match((selectForProposal(fs, { findingIds: ['nope'] }) as { message: string }).message, /not in the latest/)
  })
  it('filters take actionable items only, largest first, never a keeper or a protected item', () => {
    const picked = selectForProposal(fs, { categories: ['duplicate'] })
    assert.equal(picked.status, 'ok')
    const ids = (picked as { ids: string[] }).ids
    assert.ok(!ids.includes(keeper.id))
    assert.deepEqual(
      new Set(ids),
      new Set(fs.filter(f => f.category === 'duplicate' && isActionable(f)).map(f => f.id)),
    )
    assert.ok(copies.length > 0)
    const sizes = ids.map(id => (fs.find(f => f.id === id) as Finding).bytes)
    assert.deepEqual(
      sizes,
      sizes.toSorted((a, b) => b - a),
    )
    const safe = selectForProposal(fs, { classes: ['safe'] }) as { ids: string[] }
    assert.ok(safe.ids.every(id => (fs.find(f => f.id === id) as Finding).class === 'safe'))
  })
  it('maxBytes stops at the target and reports what it left', () => {
    const all = selectForProposal(fs, { categories: ['duplicate'] }) as { ids: string[] }
    const first = fs.find(f => f.id === all.ids[0]) as Finding
    const capped = selectForProposal(fs, { categories: ['duplicate'], maxBytes: first.bytes }) as {
      ids: string[]
      skipped: string[]
    }
    assert.deepEqual(capped.ids, [first.id])
    assert.equal(capped.skipped.length, all.ids.length - 1)
  })
  it('caps a proposal at the item limit', () => {
    const many = Array.from({ length: MAX_PROPOSAL_ITEMS + 20 }, (_, i) => ({ ...npm, id: `n${String(i)}` }))
    const picked = selectForProposal(many, { classes: ['safe'] }) as { ids: string[]; skipped: string[] }
    assert.equal(picked.ids.length, MAX_PROPOSAL_ITEMS)
    assert.equal(picked.skipped.length, 20)
  })
  it('the planner still refuses what selection lets through when cleanup rules say no', () => {
    const ids = (selectForProposal(fs, { categories: ['duplicate'] }) as { ids: string[] }).ids
    assert.equal(planCleanup(planInput({ selectedIds: ids })).status, 'ok')
    assert.equal(planCleanup(planInput({ selectedIds: ids, isScanRunning: true })).status, 'refused')
  })
  it('the question is plain: what is freed, what is deleted, what can come back, the biggest items', () => {
    const ids = (selectForProposal(fs, { categories: ['duplicate'] }) as { ids: string[] }).ids
    const p = planCleanup(planInput({ selectedIds: ids })) as {
      deleteBytes: number
      quarantineBytes: number
      list: { quarantineRoot: string }
    }
    const plan = {
      deleteBytes: p.deleteBytes,
      quarantineBytes: p.quarantineBytes,
      quarantineRoot: p.list.quarantineRoot,
      systemDrive: 'C:',
    }
    const largest = fs.find(f => f.id === ids[0]) as Finding
    const on = proposalQuestion({ findings: fs, ids, plan, isCleanupOn: true })
    assert.match(on, /^Free up about [\d.]+ (GB|MB) on C:\?/)
    assert.match(on, /You can put them back any time/)
    assert.match(on, /to D:\\Drive Cleanup Quarantine/)
    assert.ok(on.includes(largest.path.slice(-40)))
    assert.doesNotMatch(on, /\bclass [AB]\b|\bfindings?\b|SHA-256|\bUAC\b|\bDISM\b/i, 'no jargon')
    assert.ok(!on.includes('turned off'))
    assert.match(
      proposalQuestion({ findings: fs, ids, plan, isCleanupOn: false }),
      /turned off now; this answer also turns it on/,
    )
  })
  it('a quarantine on the system drive is not counted as freed, and says so', () => {
    const plan = {
      deleteBytes: 1024 ** 3,
      quarantineBytes: 5 * 1024 ** 3,
      quarantineRoot: 'C:\\Drive Cleanup Quarantine',
      systemDrive: 'C:',
    }
    assert.equal(freedEstimate(plan, 0), 1024 ** 3)
    assert.equal(freedEstimate({ ...plan, quarantineRoot: 'D:\\Drive Cleanup Quarantine' }, 2), 6 * 1024 ** 3 + 2)
    const q = proposalQuestion({ findings: fs, ids: [], plan, isCleanupOn: true })
    assert.match(q, /space comes back only when you empty it/)
  })
  it('the yes button names the size', () => {
    assert.equal(answers(14.2 * 1024 ** 3).yes, 'Free 14.2 GB')
    assert.equal(answers(0).yes, 'Clean up')
    assert.deepEqual([answers(1).review, answers(1).cancel], ['Let me choose', 'Not now'])
  })
})

const launch = (over: Partial<ElevatedLaunch> = {}): ElevatedLaunch => ({
  scriptPath: 'C:\\Users\\Asha\\.claude\\plugins\\cache\\techgramam\\drive-cleanup\\ps\\actions\\elevated.ps1',
  expectedSha256: 'a'.repeat(64),
  tasks: ['windows_temp', 'memory_dumps'],
  resultPath:
    'C:\\Users\\Asha\\AppData\\Roaming\\techgramam-drive-cleanup\\elevated\\11111111-2222-3333-4444-555555555555.json',
  powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ...over,
})
const decode = (b64: string): string => {
  const bin = atob(b64)
  let out = ''
  for (let i = 0; i < bin.length; i += 2)
    out += String.fromCodePoint(bin.codePointAt(i)! | (bin.codePointAt(i + 1)! << 8))
  return out
}

describe('administrator tasks (§20)', () => {
  it('task ids are checked, deduplicated and put in a fixed order', () => {
    assert.equal(checkTasks(['windows_temp; Remove-Item C:\\']).status, 'refused')
    assert.deepEqual((checkTasks(['component_store', 'windows_temp', 'windows_temp']) as { tasks: string[] }).tasks, [
      'windows_temp',
      'component_store',
    ])
  })
  it('only launches what Drive Cleanup builds', () => {
    assert.equal(checkLaunch(launch()), null)
    assert.match(checkLaunch(launch({ scriptPath: "C:\\x\\ps\\actions\\elevated.ps1'; calc; '" })) ?? '', /script path/)
    assert.match(checkLaunch(launch({ scriptPath: 'C:\\x\\ps\\actions\\apply.ps1' })) ?? '', /script path/)
    assert.match(checkLaunch(launch({ resultPath: 'C:\\Windows\\System32\\config\\SAM' })) ?? '', /run id/)
    assert.match(checkLaunch(launch({ powershellPath: 'C:\\Users\\Asha\\powershell.exe' })) ?? '', /System32/)
    assert.match(checkLaunch(launch({ expectedSha256: 'nope' })) ?? '', /SHA-256/)
    assert.match(checkLaunch(launch({ tasks: [] })) ?? '', /no valid task/)
  })
  it('the elevated bootstrap checks the fingerprint before running, and runs the checked text from memory', () => {
    const b = bootstrapScript(launch())
    assert.ok(b.includes(`$expected = '${'a'.repeat(64)}'`))
    assert.ok(b.includes("$tasks = @('windows_temp', 'memory_dumps')"))
    const hashAt = b.indexOf('if ($hash -ne $expected)')
    const runAt = b.indexOf('[ScriptBlock]::Create($text)')
    assert.ok(hashAt > 0 && runAt > hashAt, 'hash check comes first')
    assert.ok(b.includes('[IO.FileMode]::CreateNew'), 'never overwrites a planted file')
    assert.ok(b.includes('ReparsePoint'), 'refuses a linked result folder')
    assert.doesNotMatch(b, /Invoke-Expression|\biex\b|-File\b/)
  })
  it('the launcher asks Windows (UAC) and carries the bootstrap encoded', () => {
    const l = launcherScript(launch())
    assert.match(l, /-Verb RunAs/)
    assert.match(l, /NativeErrorCode -eq 1223/)
    const encoded = /'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(l)?.[1] ?? ''
    assert.equal(decode(encoded), bootstrapScript(launch()))
    assert.equal(decode(encodeCommand('Ä€ x')), 'Ä€ x')
  })
  it('elevated.ps1 knows exactly these tasks and stays inside its limits', () => {
    const text = ps('actions/elevated.ps1')
    const known = /\$known = @\(([^)]*)\)/.exec(text)?.[1] ?? ''
    assert.deepEqual(
      known.split(',').map(s => s.trim().replaceAll("'", '')),
      [...ELEVATED_TASK_IDS],
    )
    assert.ok(text.indexOf('IsInRole') < text.indexOf('$known'), 'checks it is elevated first')
    const code = text
      .split('\n')
      .filter(l => !l.trim().startsWith('#'))
      .join('\n')
    assert.doesNotMatch(
      code,
      /Remove-Item|Invoke-Expression|\biex\b|vssadmin|ResetBase|Windows\.old|Set-ItemProperty|New-ItemProperty|reg(\.exe)? add|DownloadString|WebClient|Invoke-WebRequest|\$env:/i,
    )
  })
  it('estimates come from the scan, or say they are unknown', () => {
    assert.equal(estimateBytes('delivery_optimization', windows()), null)
    assert.equal(estimateBytes('windows_temp', null), null)
    const w = windows()
    const temp = w.items.find(i => i.id === 'windows_temp')
    if (temp?.status === 'ok') assert.equal(estimateBytes('windows_temp', w), temp.bytes)
    assert.match(
      elevatedSummary(['windows_temp', 'delivery_optimization'], w),
      /"Windows PowerShell" permission prompt/,
    )
    assert.doesNotMatch(elevatedSummary(['delivery_optimization'], w), /about/, 'no made-up size')
    assert.equal(elevatedEstimate(['delivery_optimization'], w), 0)
  })
  it('a proposal can be administrator tasks alone, and the question says so', () => {
    const fs = findingsForPlan()
    const picked = selectForProposal(fs, { elevatedTasks: ['memory_dumps'] })
    assert.deepEqual(picked, { status: 'ok', ids: [], skipped: [], elevated: ['memory_dumps'] })
    assert.equal(selectForProposal(fs, { elevatedTasks: ['format_c'] }).status, 'refused')
    const q = proposalQuestion({
      findings: fs,
      ids: [],
      plan: { deleteBytes: 0, quarantineBytes: 0, quarantineRoot: '', systemDrive: 'C:' },
      isCleanupOn: true,
      elevatedLine: elevatedSummary(['memory_dumps'], windows()),
      elevatedBytes: elevatedEstimate(['memory_dumps'], windows()),
    })
    assert.match(q, /\n• Clean Windows itself: System memory dumps/)
  })
})

describe('review fixes (1.5)', () => {
  const fs = findingsForPlan()
  const keeper = fs.find(f => f.duplicate?.isSuggestedKeeper === true) as Finding
  const copies = fs.filter(f => f.duplicate?.groupId === keeper.duplicate?.groupId && f.id !== keeper.id)

  it('gives a quarantine to a selection of empty folders only (0 bytes)', () => {
    const empty: Finding = {
      ...keeper,
      id: 'empty',
      path: `${PROFILE}\\Downloads\\old-empty`,
      category: 'empty_folder',
      class: 'review',
      action: 'quarantine',
      isFolder: true,
      bytes: 0,
      duplicate: undefined,
      protectedBy: null,
    }
    const plan = planCleanup(planInput({ findings: [...fs, empty], selectedIds: ['empty'] }))
    assert.equal(plan.status, 'ok')
    if (plan.status === 'ok') assert.equal(plan.list.quarantineRoot, 'D:\\Drive Cleanup Quarantine')
  })

  it('never lets a selected folder take the last copy of a duplicate group', () => {
    const holder: Finding = {
      ...keeper,
      id: 'holder',
      path: keeper.path.slice(0, keeper.path.lastIndexOf('\\')),
      category: 'leftover',
      class: 'review',
      action: 'quarantine',
      isFolder: true,
      duplicate: undefined,
      protectedBy: null,
    }
    const ids = ['holder', ...copies.map(c => c.id)]
    const refused = planCleanup(planInput({ findings: [...fs, holder], selectedIds: ids }))
    assert.equal(refused.status, 'refused')
    assert.match((refused as { message: string }).message, /Keep at least one/)
    assert.equal(planCleanup(planInput({ findings: [...fs, holder], selectedIds: ['holder'] })).status, 'ok')
  })

  it('counts a file inside a folder that is itself offered only once', () => {
    const inside = `${PROFILE}\\AppData\\Local\\OldTool`
    const scan = classifyScan(
      {
        walk: null,
        windows: null,
        leftovers: {
          installedCount: 40,
          folders: [{ path: inside, bytes: 6 * 1024 ** 3, fileCount: 9, lastWriteUtc: iso(500), isTruncated: false }],
        },
        devcaches: devcaches(),
      },
      ctx(),
    )
    const withFile = classifyScan(
      {
        walk: {
          ...walk([candidate({ kind: 'large_old', path: `${inside}\\big.bin`, bytes: 5 * 1024 ** 3 })]),
          userTemp: { fileCount: 0, bytes: 0, oldCount: 0, oldBytes: 0 },
        },
        windows: null,
        leftovers: {
          installedCount: 40,
          folders: [{ path: inside, bytes: 6 * 1024 ** 3, fileCount: 9, lastWriteUtc: iso(500), isTruncated: false }],
        },
        devcaches: devcaches(),
      },
      ctx(),
    )
    assert.ok(!withFile.findings.some(f => f.path.endsWith('big.bin')), 'the file goes with its folder')
    assert.equal(withFile.recoverable.reviewBytes, scan.recoverable.reviewBytes)
  })

  it('protects OneDrive, every browser profile and mail stores', () => {
    const c = ctx()
    for (const p of [
      `${PROFILE}\\OneDrive\\Installers\\setup.exe`,
      `${PROFILE}\\OneDrive - Contoso\\old.zip`,
      `${PROFILE}\\AppData\\Local\\Vivaldi\\User Data\\Default\\Login Data`,
      `${PROFILE}\\AppData\\Roaming\\Thunderbird\\Profiles\\x.default\\Mail\\Inbox`,
      `${PROFILE}\\AppData\\Local\\Microsoft\\Outlook\\big.nst`,
    ]) {
      assert.notEqual(protectedBy(p, c), null, p)
    }
    assert.equal(
      protectedBy(`${PROFILE}\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\Cache_Data\\f_0001`, c),
      null,
      'a browser cache stays cleanable',
    )
    assert.equal(protectedBy(`${PROFILE}\\Downloads\\OneDriveSetup.exe`, c), null)
  })

  it('apply.ps1 survives a delete-only run, saves restore.json after each move, and guards OneDrive', () => {
    const apply = ps('actions/apply.ps1')
    assert.match(apply, /\$runDir = \$null\r?\nif \(\$needsQuarantine\) \{\r?\n\s+\$runDir = Join-Path/)
    assert.doesNotMatch(apply, /% 50/)
    assert.match(apply, /OneDrive\( - \.\+\)\?\$/)
    assert.match(apply, /SetAccessRuleProtection\(\$true, \$false\)/)
    assert.match(ps('actions/restore.ps1'), /Test-Forbidden \$dest/)
    assert.match(ps('actions/elevated.ps1'), /'Temp'\) '\*' \$now\.AddDays\(-7\) \$true \$true/)
  })
})

describe('open gaps closed (1.6)', () => {
  it('runs administrator tasks for a profile with an apostrophe or $ in its name', () => {
    const odd = launch({
      scriptPath: "C:\\Users\\D'Souza$\\.claude\\plugins\\cache\\techgramam\\drive-cleanup\\ps\\actions\\elevated.ps1",
      resultPath:
        "C:\\Users\\D'Souza$\\AppData\\Roaming\\techgramam-drive-cleanup\\elevated\\11111111-2222-3333-4444-555555555555.json",
    })
    assert.equal(checkLaunch(odd), null)
    const boot = bootstrapScript(odd)
    assert.ok(boot.includes("$scriptPath = 'C:\\Users\\D''Souza$\\"), 'the apostrophe is doubled inside single quotes')
    assert.equal(quote('a\u2019b'), "'a\u2019\u2019b'", 'PowerShell reads typographic quotes as quotes too')
    assert.match(checkLaunch(launch({ resultPath: 'C:\\x\\"evil".json' })) ?? '', /result path/)
  })

  it('never picks an external disk for quarantine or for moving folders, unless chosen by name', () => {
    const base = volume()
    const usb = {
      letter: 'E:',
      label: 'Backup',
      fileSystem: 'NTFS',
      totalBytes: 2 * 1024 ** 4,
      freeBytes: 1.5 * 1024 ** 4,
      isSystem: false,
      mediaType: 3,
      healthStatus: 'Healthy',
      isExternal: true,
    }
    const v = { ...base, drives: [...base.drives, usb] }
    const auto = chooseQuarantineRoot(v, 'auto', 5 * 1024 ** 3)
    assert.ok(auto.status === 'ok' && auto.drive === 'C:', 'auto skips E:')
    const named = chooseQuarantineRoot(v, 'E:', 5 * 1024 ** 3)
    assert.ok(named.status === 'ok' && named.drive === 'E:', 'a drive the person chose is used')
    assert.equal(otherDrive(v), undefined)
    const parsed = VolumeCheck({ ...v, drives: [{ ...usb, isExternal: undefined }] }, 'volume')
    assert.equal(parsed.drives[0]?.isExternal, null, 'older output without the field still reads')
  })

  it('apply.ps1 refuses quarantine paths over 260 characters and expands 8.3 names; restore refuses short names', () => {
    const apply = ps('actions/apply.ps1')
    assert.match(apply, /\$maxPath = 259/)
    assert.match(apply, /\$path = Resolve-LongName/)
    assert.match(apply, /GetFileSystemInfos\(\$seg\)/)
    assert.match(ps('actions/restore.ps1'), /if \(\$path -match '~\\d'\) \{ return \$true \}/)
    const walkPs = ps('scan/walk.ps1')
    assert.match(walkPs, /PathTooLongException/)
    assert.match(walkPs, /elseif \(\$isUserArea -and \$len -ge \$largeOldBytes/)
    assert.match(ps('scan/volume.ps1'), /\$externalBuses = @\(4, 7, 12, 13\)/)
  })

  it('reports long paths as not read', () => {
    const w = { ...walk(), longPathFolders: 3, longPathSample: ['C:\\Users\\Asha\\deep'] }
    assert.equal(RawWalkCheck(w, 'walk').longPathFolders, 3)
  })
})

describe('second review fixes (1.7)', () => {
  it('apply.ps1 keeps protected files inside folders it deletes or moves, and records a move before originals go', () => {
    const apply = ps('actions/apply.ps1')
    assert.match(apply, /if \(\$null -ne \(Get-NameReason \$child\.FullName \$isDir\)\) \{ \$kept\+\+; continue \}/)
    assert.match(apply, /It contains a protected item/)
    assert.match(apply, /state = 'moving'/)
    assert.match(apply, /\[System\.IO\.File\]::Replace\(\$temp, \$target, \$null\)/)
    assert.match(apply, /belongs to another account/)
    assert.match(apply, /'PerfLogs'/)
    assert.ok(
      apply.indexOf("state = 'moving'") < apply.indexOf('[System.IO.File]::Delete($f)'),
      'recorded before any original is removed',
    )
  })
  it('restore.ps1 resolves paths, checks owners, merges a cut-short move and copies under a temporary name', () => {
    const restore = ps('actions/restore.ps1')
    assert.match(restore, /GetFullPath\(\[string\]\$item\.destination\)/)
    assert.match(restore, /GetFullPath\(\[string\]\$item\.original\)/)
    assert.match(restore, /belongs to another account/)
    assert.match(restore, /\$merge = \$state -eq 'moving'/)
    assert.match(restore, /\.dc-restore/)
    assert.match(restore, /Documents\\WindowsPowerShell/)
  })
  it('scripts stop in time and say so', () => {
    assert.match(ps('actions/clean-cache.ps1'), /isTruncated  = \$isTruncated/)
    assert.match(ps('actions/clean-cache.ps1'), /function Test-Keep/)
    assert.match(ps('scan/verify.ps1'), /notHashed/)
    assert.match(ps('scan/hash.ps1'), /skippedTooBig/)
    assert.match(ps('scan/dev-caches.ps1'), /\$overallMs = 300000/)
    assert.match(ps('actions/purge.ps1'), /belongs to another account/)
  })
  it('the new caches are measured by the script that the table names', () => {
    const script = ps('scan/dev-caches.ps1')
    for (const id of [
      'ollama_models',
      'huggingface',
      'iphone_backups',
      'cargo_registry',
      'jetbrains_caches',
      'cursor_cache',
    ]) {
      assert.match(script, new RegExp(`id = '${id}'`), id)
      assert.ok(
        DEV_CACHES.some(c => c.id === id),
        id,
      )
    }
    assert.match(ps('actions/clean-cache.ps1'), /cursor_cache\s+=/)
  })
})
