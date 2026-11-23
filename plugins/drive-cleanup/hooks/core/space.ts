// Using the space well, beyond cleaning (PLAN.md §21): what to move to another
// drive, which disks never shrink by themselves, and quarantine that still holds
// space. Recommendations only, each with manual steps, risk and undo: Drive
// Cleanup moves no folder, changes no setting and runs no command for any of it.

import { isUnder, normalizePath } from './paths.ts'
import { sizeText } from './format.ts'
import type { RunIndexEntry } from './runs.ts'
import type { RawDevCaches, RawDrive, RawVolume, RawWalk, Recommendation } from './types.ts'

const GB = 1024 ** 3
const DAY_MS = 86_400_000

/** A personal folder worth moving: at least this big. */
export const MOVE_FOLDER_MIN_BYTES = 5 * GB
/** Developer caches worth moving, in total. */
export const MOVE_CACHES_MIN_BYTES = 5 * GB
/** A virtual disk worth compacting or moving. */
export const VIRTUAL_DISK_MIN_BYTES = 5 * GB
/** Quarantine runs older than this are worth a reminder. */
export const QUARANTINE_REMIND_DAYS = 14

const PERSONAL_FOLDERS = ['Videos', 'Pictures', 'Music', 'Documents', 'Downloads', 'Desktop'] as const

/** The internal, non-system NTFS/ReFS drive with the most free space, if any (folders moved to an external disk vanish when it is unplugged). */
export function otherDrive(volume: RawVolume | null): RawDrive | undefined {
  return (volume?.drives ?? [])
    .filter(
      d => !d.isSystem && d.isExternal !== true && /^(ntfs|refs)$/i.test(d.fileSystem) && /^[A-Za-z]:$/.test(d.letter),
    )
    .toSorted((a, b) => b.freeBytes - a.freeBytes)[0]
}

/** Room for `bytes` on `drive`, keeping 10 % and 10 GB free there afterwards. */
const fitsOn = (drive: RawDrive, bytes: number): boolean =>
  drive.freeBytes - bytes >= Math.max(drive.totalBytes * 0.1, 10 * GB)

function folderBytes(walk: RawWalk, path: string): number | null {
  const want = normalizePath(path)
  return walk.folders.find(f => normalizePath(f.path) === want)?.bytes ?? null
}

/** `user` with the letter of `drive`: C:\Users\ana → D:\Users\ana. */
const onDrive = (path: string, drive: RawDrive): string => `${drive.letter.toUpperCase()}${path.slice(2)}`

export type SpaceInput = {
  volume: RawVolume | null
  walk: RawWalk | null
  devcaches: RawDevCaches | null
}

export function spaceRecommendations({ volume, walk, devcaches }: SpaceInput): Recommendation[] {
  const out: Recommendation[] = []
  const other = otherDrive(volume)
  const profile = volume?.userProfile ?? null

  // 1. Big personal folders: they belong on the larger data drive.
  if (other !== undefined && walk !== null && profile !== null) {
    const big = PERSONAL_FOLDERS.map(name => ({ name, bytes: folderBytes(walk, `${profile}\\${name}`) ?? 0 }))
      .filter(f => f.bytes >= MOVE_FOLDER_MIN_BYTES)
      .toSorted((a, b) => b.bytes - a.bytes)
    const fitting = big.filter(f => fitsOn(other, f.bytes))
    if (fitting.length > 0) {
      const total = fitting.reduce((s, f) => s + f.bytes, 0)
      const first = fitting[0]!
      out.push({
        id: 'move_personal_folders',
        title: `Move ${fitting.map(f => f.name).join(', ')} to ${other.letter}`,
        severity: 'suggested',
        evidence: `${fitting.map(f => `${f.name} ${sizeText(f.bytes)}`).join(', ')} on the system drive; ${other.letter} has ${sizeText(other.freeBytes)} free.`,
        steps: [
          `In File Explorer, right-click ${first.name} (under This PC or Quick access) > Properties > Location.`,
          `Type ${onDrive(`${profile}\\${first.name}`, other)}, press Move…, and answer Yes to move the files.`,
          'Repeat for each folder. Apps keep finding the folder: Windows updates its location for them.',
          'If the folder is backed up by OneDrive (Settings > Backup), move it with OneDrive instead, or stop its backup first.',
        ],
        risk: `Low. The files are moved, not copied: keep ${other.letter} connected. A drive that is removed or fails takes these folders with it, so keep a backup.`,
        undo: 'Same Properties > Location tab: Restore Default, then Yes to move the files back.',
        estimatedBytes: total,
      })
    }
  }

  // 2. Where new apps and files go.
  if (other !== undefined && fitsOn(other, 50 * GB)) {
    out.push({
      id: 'new_content_location',
      title: `Save new apps and files on ${other.letter}`,
      severity: 'info',
      evidence: `${other.letter} has ${sizeText(other.freeBytes)} free; by default Windows saves new apps, documents, music, photos and videos on the system drive.`,
      steps: [
        'Open Settings > System > Storage > Advanced storage settings > Where new content is saved.',
        `Choose ${other.letter} for New apps, and for the kinds of files you keep most.`,
        `Games: in Steam, Xbox or Epic, add a library on ${other.letter} and move large games there from the launcher.`,
      ],
      risk: 'Low. Only new content goes there; nothing already on C: moves.',
      undo: 'Choose the system drive again on the same page.',
      estimatedBytes: null,
    })
  }

  // 3. Developer caches that will grow back: move them instead of cleaning forever.
  if (other !== undefined && devcaches !== null && profile !== null) {
    const sizeOf = (ids: string[]): number =>
      devcaches.caches.filter(c => ids.includes(c.id) && c.isPresent).reduce((s, c) => s + c.bytes, 0)
    const base = `${other.letter.toUpperCase()}\\DevCaches`
    const moves = [
      { bytes: sizeOf(['npm_cache', 'npm_npx']), step: `npm: npm config set cache ${base}\\npm` },
      { bytes: sizeOf(['pnpm_store', 'pnpm_cache']), step: `pnpm: pnpm config set store-dir ${base}\\pnpm-store` },
      { bytes: sizeOf(['yarn_cache', 'yarn_berry']), step: `Yarn: yarn config set cache-folder ${base}\\yarn` },
      { bytes: sizeOf(['pip_cache']), step: `pip: setx PIP_CACHE_DIR ${base}\\pip` },
      { bytes: sizeOf(['nuget_packages', 'nuget_http']), step: `NuGet: setx NUGET_PACKAGES ${base}\\nuget\\packages` },
      { bytes: sizeOf(['gradle_caches', 'gradle_wrapper']), step: `Gradle: setx GRADLE_USER_HOME ${base}\\gradle` },
      {
        bytes: sizeOf(['maven_repo']),
        step: `Maven: in %USERPROFILE%\\.m2\\settings.xml set <localRepository>${base}\\m2</localRepository>`,
      },
      {
        bytes: sizeOf(['docker_data']),
        step: `Docker Desktop: Settings > Resources > Advanced > Disk image location: ${base}\\docker`,
      },
    ].filter(m => m.bytes >= 256 * 1024 ** 2)
    const total = moves.reduce((s, m) => s + m.bytes, 0)
    if (total >= MOVE_CACHES_MIN_BYTES && fitsOn(other, total)) {
      out.push({
        id: 'move_dev_caches',
        title: `Keep developer caches on ${other.letter}`,
        severity: 'suggested',
        evidence: `Developer caches use ${sizeText(total)} on the system drive and grow back after every cleanup.`,
        steps: [
          'Close your editors, terminals and Docker, then run what applies (one line per tool):',
          ...moves.toSorted((a, b) => b.bytes - a.bytes).map(m => `${m.step}   (${sizeText(m.bytes)} now)`),
          'Open a new terminal so setx takes effect. Then clean the old caches on C: with /drive-cleanup:free-space; tools fill the new place as they need.',
        ],
        risk: 'Low. Tools download again what they need into the new place; the first builds are slower.',
        undo: 'npm/pnpm/yarn: config delete for the same key. setx: remove the variable in Settings > System > About > Advanced system settings > Environment Variables.',
        estimatedBytes: total,
      })
    }
  }

  // 4. Virtual disks (WSL, Docker, Hyper-V): they grow and never shrink by themselves.
  if (walk !== null) {
    const disks = walk.largest.filter(f => /\.vhdx$/i.test(f.path) && f.bytes >= VIRTUAL_DISK_MIN_BYTES)
    if (disks.length > 0) {
      const total = disks.reduce((s, f) => s + f.bytes, 0)
      const moveStep =
        other === undefined
          ? []
          : [
              `To move a WSL distribution off C:: wsl --shutdown, then wsl --manage <name> --move ${other.letter.toUpperCase()}\\WSL\\<name> (WSL 2.3 or later; wsl --list shows the names).`,
            ]
      out.push({
        id: 'virtual_disks',
        title: 'Shrink or move virtual disks (WSL, Docker)',
        severity: 'suggested',
        evidence: `${String(disks.length)} virtual disk file${disks.length === 1 ? '' : 's'} use ${sizeText(total)}: ${disks
          .slice(0, 3)
          .map(f => `${f.path} (${sizeText(f.bytes)})`)
          .join(
            '; ',
          )}. They grow as Linux or Docker uses space, and keep that size after files are deleted inside them.`,
        steps: [
          'Inside first: delete what you no longer need in Linux, and run docker system df then docker builder prune / docker image prune.',
          'Then let the disk give space back: in an administrator terminal, wsl --shutdown, then wsl --manage <name> --set-sparse true (WSL 2.0 or later). For Docker Desktop: Troubleshoot > Clean / Purge data.',
          ...moveStep,
          'Never delete a .vhdx file yourself: it holds the whole Linux system or all Docker images.',
        ],
        risk: 'Medium. Back up important files inside the distribution first (wsl --export <name> backup.tar).',
        undo: 'Sparse: wsl --manage <name> --set-sparse false. Move: move it back the same way.',
        estimatedBytes: null,
      })
    }
  }

  // 5. OneDrive files kept on this PC.
  if (walk !== null && profile !== null) {
    const oneDrive = walk.folders
      .filter(f => /^onedrive( - .+)?$/i.test(f.path.split('\\').pop() ?? '') && isUnder(f.path, profile))
      .reduce((s, f) => s + f.bytes, 0)
    if (oneDrive >= MOVE_FOLDER_MIN_BYTES) {
      out.push({
        id: 'onedrive_files',
        title: 'Keep OneDrive files online only',
        severity: 'suggested',
        evidence: `${sizeText(oneDrive)} of OneDrive files are downloaded to this PC.`,
        steps: [
          'In File Explorer, right-click the OneDrive folder (or a large subfolder) > Free up space.',
          'Or: OneDrive settings > Sync and back up > Advanced settings > Files On-Demand > Free up disk space.',
          'The files stay in OneDrive and download again when you open them (you need to be online).',
        ],
        risk: 'Low. Files are still in your OneDrive; without internet you cannot open them.',
        undo: 'Right-click > Always keep on this device.',
        estimatedBytes: oneDrive,
      })
    }
  }

  return out
}

/** Quarantine that still takes space: a reminder to restore or delete it for good. */
export function quarantineRecommendation(
  runs: readonly RunIndexEntry[],
  systemDrive: string,
  nowMs: number,
): Recommendation | undefined {
  const active = runs.filter(e => e.kind === 'cleanup' && e.quarantineState === 'active' && e.quarantinedBytes > 0)
  if (active.length === 0) return undefined
  const old = active.filter(e => nowMs - Date.parse(e.startedAt) >= QUARANTINE_REMIND_DAYS * DAY_MS)
  const drive = systemDrive.toUpperCase()
  const onSystem = active.filter(e => (e.quarantineRoot ?? '').toUpperCase().startsWith(drive))
  if (old.length === 0 && onSystem.length === 0) return undefined
  const held = active.reduce((s, e) => s + e.quarantinedBytes, 0)
  const onSystemBytes = onSystem.reduce((s, e) => s + e.quarantinedBytes, 0)
  return {
    id: 'quarantine_waiting',
    title: `${sizeText(held)} is waiting in quarantine`,
    severity: onSystemBytes > 0 ? 'important' : 'suggested',
    evidence: [
      `${String(active.length)} cleanup${active.length === 1 ? '' : 's'} in quarantine hold ${sizeText(held)}`,
      old.length > 0 ? `, ${String(old.length)} of them older than ${String(QUARANTINE_REMIND_DAYS)} days` : '',
      onSystemBytes > 0 ? `; ${sizeText(onSystemBytes)} of it is still on ${drive}, so it frees nothing there yet` : '',
      '.',
    ].join(''),
    steps: [
      'Check you have not missed anything: /drive-cleanup:quarantine lists each cleanup.',
      'Something missing? Put that cleanup back (Restore).',
      'Sure? Delete it for good with /drive-cleanup:quarantine (you are asked first), or in the pane > Undo.',
    ],
    risk: 'Deleting for good cannot be undone.',
    undo: 'Until you delete it for good, Restore puts everything back.',
    estimatedBytes: onSystemBytes > 0 ? onSystemBytes : held,
  }
}
