import type { EngineInterface } from 'claude-code'
import { finalReport, type Verification } from './core/reports.ts'
import { runSummaryText } from './core/runs.ts'
import type { RawVerify, RunRecord } from './core/types.ts'
import { parseOutput, RawVerifyCheck, RawVolumeCheck } from './core/validate.ts'
import { isCleanupBusy, readManifest, readRunIndex, readRunRecord } from './cleanup.ts'
import { runScript } from './safe-shell.ts'
import { readDataFile, writeDataFile } from './safe-writer.ts'
import { loadLatestScan, setLastAuditFolder } from './scan.ts'

// Phase 7 (PLAN.md §9): after a cleanup, measure free space again and check
// that tools, projects and quarantined files are intact. Read-only, apart from
// writing its report in the data folder.

const LATEST = 'verify/latest.json'

export type VerifyOutcome =
  { status: 'ok'; verification: Verification; folder: string } | { status: 'refused'; message: string }

let running = false

const stamp = (iso: string): string => iso.replaceAll(/[-:]/g, '').replace('T', '_').slice(0, 15)

export async function verifyCleanup($: EngineInterface): Promise<VerifyOutcome> {
  if (running || isCleanupBusy())
    return { status: 'refused', message: 'A cleanup or a verification is running. Wait for it to finish.' }
  running = true
  try {
    const scan = await loadLatestScan($)
    const index = await readRunIndex($)
    const since = scan === undefined ? index : index.filter(e => e.startedAt >= scan.meta.createdAt)

    const listId = crypto.randomUUID()
    const list = {
      projects: scan?.walk?.projectRootSample ?? [],
      quarantine: index
        .filter(e => e.kind === 'cleanup' && e.quarantineState === 'active' && e.quarantineRoot !== null)
        .map(e => ({ runId: e.runId, root: e.quarantineRoot })),
    }
    const written = await writeDataFile($, `runs/pending/${listId}.json`, JSON.stringify(list))
    if (written.status !== 'written') return { status: 'refused', message: written.detail }

    let verify: RawVerify | null = null
    let verifyDetail: string | null = null
    const ran = await runScript($, 'verify', { DC_LIST_ID: listId })
    const parsed = ran.status === 'ok' ? parseOutput(RawVerifyCheck, ran.stdout, 'verify.ps1') : ran
    if (parsed.status === 'ok') verify = parsed.data
    else verifyDetail = parsed.detail

    let freeAfter: number | null = null
    const vol = await runScript($, 'volume')
    const volParsed = vol.status === 'ok' ? parseOutput(RawVolumeCheck, vol.stdout, 'volume.ps1') : vol
    if (volParsed.status === 'ok') freeAfter = volParsed.data.drives.find(d => d.isSystem)?.freeBytes ?? null

    const records: RunRecord[] = []
    for (const e of since.slice(0, 50)) {
      const r = await readRunRecord($, e.runId)
      if (r !== undefined) records.push(r)
    }
    const systemDrive = (scan?.volume?.systemDrive ?? 'C:').toUpperCase()
    const verification: Verification = {
      at: new Date().toISOString(),
      scanId: scan?.meta.scanId ?? null,
      freeBeforeBytes: scan?.volume?.drives.find(d => d.isSystem)?.freeBytes ?? null,
      freeAfterBytes: freeAfter,
      // Quarantine on the system drive frees nothing until purged, and purging
      // quarantine on another drive frees nothing on it: count each once.
      reportedFreedBytes: records.reduce(
        (s, r) =>
          s +
          r.deletedBytes +
          ((r.quarantineRoot ?? '').toUpperCase().startsWith(systemDrive)
            ? r.purgedBytes
            : r.kind === 'cleanup'
              ? r.quarantinedBytes
              : 0),
        0,
      ),
      quarantinedOnSystemDriveBytes: index
        .filter(
          e =>
            e.kind === 'cleanup' &&
            e.quarantineState === 'active' &&
            (e.quarantineRoot ?? '').toUpperCase().startsWith(systemDrive),
        )
        .reduce((s, e) => s + e.quarantinedBytes, 0),
      verify,
      verifyDetail,
      runs: records.map(r => ({ runId: r.runId, kind: r.kind, startedAt: r.startedAt, summary: runSummaryText(r) })),
    }
    await writeDataFile($, LATEST, JSON.stringify(verification))
    const folder = `audits/${stamp(verification.at)}`
    const report = await writeDataFile($, `${folder}/final_cleanup_report.md`, finalReport(verification))
    await writeDataFile($, `${folder}/deletion_manifest.csv`, await readManifest($))
    const path = report.status === 'written' ? report.path.replace(/\\[^\\]+$/, '') : ''
    if (path !== '') await setLastAuditFolder($, path)
    return { status: 'ok', verification, folder: path }
  } finally {
    running = false
  }
}

export async function readLatestVerification($: EngineInterface): Promise<Verification | undefined> {
  const text = await readDataFile($, LATEST)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as Verification
  } catch {
    return undefined
  }
}
