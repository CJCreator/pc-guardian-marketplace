// Unit tests for using the space well (hooks/core/space.ts). Run from the repository root:
//   bun test

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RunIndexEntry } from '../../hooks/core/runs.ts'
import { otherDrive, quarantineRecommendation, spaceRecommendations } from '../../hooks/core/space.ts'
import type { RawDevCache, RawDrive, RawWalk } from '../../hooks/core/types.ts'
import { NOW, PROFILE, volume, walk } from './fixtures.ts'

const GB = 1024 ** 3

const dataDrive = (over: Partial<RawDrive> = {}): RawDrive => ({
  letter: 'D:',
  label: 'Data',
  fileSystem: 'NTFS',
  totalBytes: 1024 * GB,
  freeBytes: 700 * GB,
  isSystem: false,
  mediaType: 4,
  healthStatus: 'Healthy',
  ...over,
})

const withD = (over: Partial<RawDrive> = {}) => {
  const v = volume()
  return { ...v, drives: [...v.drives, dataDrive(over)] }
}

const walkWith = (folders: RawWalk['folders'], largest: RawWalk['largest'] = []): RawWalk => {
  const w = walk()
  return { ...w, folders: [...w.folders, ...folders], largest: [...w.largest, ...largest] }
}

const cache = (id: string, bytes: number): RawDevCache => ({
  id,
  isPresent: true,
  bytes,
  fileCount: 1000,
  lastWriteUtc: null,
  isRunning: false,
  isTruncated: false,
  roots: [],
})

const run = (over: Partial<RunIndexEntry>): RunIndexEntry => ({
  runId: '11111111-2222-3333-4444-555555555555',
  kind: 'cleanup',
  startedAt: new Date(NOW - 30 * 86_400_000).toISOString(),
  quarantineRoot: 'D:\\Drive Cleanup Quarantine',
  quarantineDir: null,
  quarantinedBytes: 6 * GB,
  deletedBytes: 0,
  restoredBytes: 0,
  purgedBytes: 0,
  done: 10,
  skipped: 0,
  quarantineState: 'active',
  ofRunId: null,
  ...over,
})

const ids = (recs: { id: string }[]) => recs.map(r => r.id)

describe('another drive', () => {
  it('picks the non-system NTFS drive with the most free space', () => {
    const v = withD()
    const e = dataDrive({ letter: 'E:', freeBytes: 900 * GB, totalBytes: 2000 * GB })
    const usb = dataDrive({ letter: 'F:', fileSystem: 'exFAT', freeBytes: 2000 * GB })
    assert.equal(otherDrive({ ...v, drives: [...v.drives, e, usb] })?.letter, 'E:')
    assert.equal(otherDrive(volume()), undefined)
  })
})

describe('space recommendations', () => {
  const videos = { path: `${PROFILE}\\Videos`, depth: 3, bytes: 60 * GB, fileCount: 300 }
  const docs = { path: `${PROFILE}\\Documents`, depth: 3, bytes: 2 * GB, fileCount: 3000 }

  it('suggests moving big personal folders only when another drive has room', () => {
    const recs = spaceRecommendations({ volume: withD(), walk: walkWith([videos, docs]), devcaches: null })
    const move = recs.find(r => r.id === 'move_personal_folders')
    assert.ok(move)
    assert.match(move.title, /Videos/)
    assert.doesNotMatch(move.title, /Documents/, 'small folders stay')
    assert.equal(move.estimatedBytes, 60 * GB)
    assert.match(move.steps.join(' '), /D:\\Users\\Asha\\Videos/)
    assert.ok(ids(recs).includes('new_content_location'))

    const none = spaceRecommendations({ volume: volume(), walk: walkWith([videos]), devcaches: null })
    assert.deepEqual(ids(none), [], 'no other drive: nothing to move to')
    const full = spaceRecommendations({
      volume: withD({ freeBytes: 50 * GB }),
      walk: walkWith([videos]),
      devcaches: null,
    })
    assert.ok(!ids(full).includes('move_personal_folders'), 'D: would drop under 10 % / 10 GB')
  })

  it('suggests moving developer caches that grow back, with each tool’s own setting', () => {
    const devcaches = { caches: [cache('npm_cache', 4 * GB), cache('gradle_caches', 3 * GB), cache('pip_cache', 10)] }
    const recs = spaceRecommendations({ volume: withD(), walk: null, devcaches })
    const move = recs.find(r => r.id === 'move_dev_caches')
    assert.ok(move)
    const steps = move.steps.join('\n')
    assert.match(steps, /npm config set cache D:\\DevCaches\\npm/)
    assert.match(steps, /GRADLE_USER_HOME/)
    assert.doesNotMatch(steps, /PIP_CACHE_DIR/, 'tiny caches are left out')
    assert.equal(move.estimatedBytes, 7 * GB)
    const small = { caches: [cache('npm_cache', GB)] }
    assert.ok(!ids(spaceRecommendations({ volume: withD(), walk: null, devcaches: small })).includes('move_dev_caches'))
  })

  it('explains virtual disks without ever offering to delete them', () => {
    const vhdx = {
      path: `${PROFILE}\\AppData\\Local\\Packages\\CanonicalGroupLimited.Ubuntu\\LocalState\\ext4.vhdx`,
      bytes: 40 * GB,
      modifiedUtc: new Date(NOW).toISOString(),
      accessedUtc: new Date(NOW).toISOString(),
      createdUtc: new Date(NOW).toISOString(),
      inProject: false,
    }
    const recs = spaceRecommendations({ volume: withD(), walk: walkWith([], [vhdx]), devcaches: null })
    const disk = recs.find(r => r.id === 'virtual_disks')
    assert.ok(disk)
    assert.match(disk.steps.join(' '), /--set-sparse true/)
    assert.match(disk.steps.join(' '), /--move D:\\WSL/)
    assert.match(disk.steps.join(' '), /Never delete a \.vhdx/)
    assert.equal(disk.estimatedBytes, null)
  })

  it('points to OneDrive Files On-Demand for big downloaded OneDrive folders', () => {
    const od = { path: `${PROFILE}\\OneDrive - Contoso`, depth: 3, bytes: 20 * GB, fileCount: 9000 }
    const recs = spaceRecommendations({ volume: volume(), walk: walkWith([od]), devcaches: null })
    assert.ok(ids(recs).includes('onedrive_files'))
  })
})

describe('quarantine reminder', () => {
  it('stays quiet for a fresh quarantine on another drive', () => {
    const fresh = run({ startedAt: new Date(NOW - 2 * 86_400_000).toISOString() })
    assert.equal(quarantineRecommendation([fresh], 'C:', NOW), undefined)
    assert.equal(quarantineRecommendation([], 'C:', NOW), undefined)
  })

  it('reminds about old runs, and flags quarantine on C: that frees nothing', () => {
    const old = quarantineRecommendation([run({})], 'C:', NOW)
    assert.equal(old?.severity, 'suggested')
    assert.match(old?.evidence ?? '', /older than 14 days/)

    const onC = quarantineRecommendation(
      [run({ quarantineRoot: 'C:\\Drive Cleanup Quarantine', startedAt: new Date(NOW).toISOString() })],
      'C:',
      NOW,
    )
    assert.equal(onC?.severity, 'important')
    assert.match(onC?.evidence ?? '', /frees nothing there yet/)
    assert.equal(onC?.estimatedBytes, 6 * GB)
  })

  it('ignores restored and deleted runs', () => {
    const done = [run({ quarantineState: 'restored' }), run({ quarantineState: 'purged' })]
    assert.equal(quarantineRecommendation(done, 'C:', NOW), undefined)
  })
})
