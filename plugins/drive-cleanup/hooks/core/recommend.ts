// Phase 6 (PLAN.md §8): Windows optimisation, as recommendations only. Each
// has the evidence, manual steps, the risk and how to undo it. Drive Cleanup
// runs none of them.

import { percentText, sizeText } from './format.ts'
import type { RawVolume, RawWalk, RawWindows, RawWindowsItem, Recommendation } from './types.ts'

const GB = 1024 ** 3

const item = (win: RawWindows | null, id: RawWindowsItem['id']): RawWindowsItem | undefined =>
  win?.items.find(i => i.id === id && i.status === 'ok')

export function windowsRecommendations(
  volume: RawVolume | null,
  win: RawWindows | null,
  walk: RawWalk | null = null,
): Recommendation[] {
  const out: Recommendation[] = []
  const system = volume?.drives.find(d => d.isSystem)

  if (system !== undefined && system.totalBytes > 0) {
    const freeShare = system.freeBytes / system.totalBytes
    if (freeShare < 0.1 || system.freeBytes < 10 * GB) {
      out.push({
        id: 'low_free_space',
        title: `${system.letter} is low on free space`,
        severity: 'important',
        evidence: `${sizeText(system.freeBytes)} free of ${sizeText(system.totalBytes)} (${percentText(system.freeBytes, system.totalBytes)}).`,
        steps: [
          'Start with caches and temporary files (apps rebuild them), then look at your old files.',
          'Windows needs free space for updates: aim for at least 15 % or 20 GB free.',
        ],
        risk: 'Below about 10 % free, Windows updates can fail and the PC slows down.',
        undo: 'Nothing to undo.',
        estimatedBytes: null,
      })
    }
    if (system.healthStatus !== null && !/^healthy$/i.test(system.healthStatus)) {
      out.push({
        id: 'disk_health',
        title: 'The system disk reports a health problem',
        severity: 'important',
        evidence: `Windows reports the disk's health as "${system.healthStatus}".`,
        steps: [
          'Back up your files now (File History, OneDrive or an external drive).',
          'Check Settings > System > Storage > Advanced storage settings > Disks & volumes > Properties.',
        ],
        risk: 'A failing disk can lose data. Cleaning does not fix it.',
        undo: 'Nothing to undo.',
        estimatedBytes: null,
      })
    }
  }

  if (volume !== null && volume.storageSense.isEnabled === false) {
    out.push({
      id: 'storage_sense_off',
      title: 'Turn on Storage Sense',
      severity: 'suggested',
      evidence: 'Storage Sense is off for this account.',
      steps: [
        'Open Settings > System > Storage > Storage Sense.',
        'Turn on "Automatic User content cleanup" and choose when it runs.',
        'Set Temp files and Recycle Bin cleanup; leave Downloads at "Never" unless you want it.',
      ],
      risk: 'Low. It deletes only what you choose there.',
      undo: 'Turn Storage Sense off on the same page.',
      estimatedBytes: null,
    })
  }

  const updates = item(win, 'update_cache')
  if (updates !== undefined && updates.bytes >= GB) {
    out.push({
      id: 'windows_update_cache',
      title: 'Clean Windows Update downloads',
      severity: 'suggested',
      evidence: `Downloaded Windows updates (SoftwareDistribution\\Download) use ${sizeText(updates.bytes)}.`,
      steps: [
        'Drive Cleanup can do this: ask Claude to include Windows Update downloads (administrator task windows_update_cache); Windows asks for permission.',
        'It waits while updates are installing and restarts the update service afterwards.',
        '"Windows Update Cleanup" in Disk Cleanup is something else: it removes old Windows components (the component_store task).',
      ],
      risk: 'Low. Windows downloads again what it still needs.',
      undo: 'Not needed: Windows re-downloads updates when required.',
      estimatedBytes: updates.bytes,
    })
  }

  const old = item(win, 'windows_old')
  if (old !== undefined && old.bytes > 0) {
    out.push({
      id: 'windows_old',
      title: 'Remove the previous Windows installation',
      severity: 'suggested',
      evidence: `Windows.old uses ${sizeText(old.bytes)}.`,
      steps: [
        'Make sure the current Windows works well for you.',
        'Settings > System > Storage > Temporary files > "Previous Windows installation(s)" > Remove files.',
      ],
      risk: 'You can no longer go back to the previous version of Windows.',
      undo: 'Cannot be undone.',
      estimatedBytes: old.bytes,
    })
  }

  const dumps = ['memory_dmp', 'minidump', 'live_kernel_reports'] as const
  const dumpBytes = dumps.reduce((sum, id) => sum + (item(win, id)?.bytes ?? 0), 0)
  if (dumpBytes >= 256 * 1024 * 1024) {
    out.push({
      id: 'memory_dumps',
      title: 'Remove system memory dumps',
      severity: 'suggested',
      evidence: `System crash dumps use ${sizeText(dumpBytes)}.`,
      steps: [
        'Drive Cleanup can do this: ask Claude to include memory dumps (administrator task memory_dumps); Windows asks for permission.',
      ],
      risk: 'Low. They only help diagnose a past crash.',
      undo: 'Cannot be undone.',
      estimatedBytes: dumpBytes,
    })
  }

  const hiber = item(win, 'hiberfil')
  if (hiber !== undefined && hiber.bytes >= 8 * GB) {
    out.push({
      id: 'hibernation_file',
      title: 'Shrink the hibernation file',
      severity: 'info',
      evidence: `hiberfil.sys uses ${sizeText(hiber.bytes)}.`,
      steps: [
        'Drive Cleanup can make it smaller (administrator task hibernation_reduce: powercfg /h /type reduced); Fast Startup keeps working.',
        'Or turn hibernation off yourself in an administrator terminal: powercfg /h off',
      ],
      risk: 'Turning it off also turns off Fast Startup, so the PC may start a little slower.',
      undo: 'powercfg /h /type full, or powercfg /h on.',
      estimatedBytes: hiber.bytes,
    })
  }

  if (win !== null && win.shadowStorage.status === 'ok' && system !== undefined) {
    const used = win.shadowStorage.usedBytes
    if (system.totalBytes > 0 && used / system.totalBytes > 0.1) {
      out.push({
        id: 'restore_points',
        title: 'Restore points use a lot of space',
        severity: 'info',
        evidence: `Restore points use ${sizeText(used)} (${percentText(used, system.totalBytes)} of ${system.letter}).`,
        steps: [
          'Open Settings > System > About > System protection (or press Win+R and run SystemPropertiesProtection).',
          `Select ${system.letter}, press Configure, and lower "Max Usage" to 5–8 %.`,
        ],
        risk: 'Fewer restore points to go back to.',
        undo: 'Raise Max Usage again.',
        estimatedBytes: null,
      })
    }
  }

  const pagefile = item(win, 'pagefile')
  if (pagefile !== undefined && pagefile.bytes >= 8 * GB) {
    out.push({
      id: 'page_file',
      title: 'The page file is large',
      severity: 'info',
      evidence: `pagefile.sys uses ${sizeText(pagefile.bytes)}. Windows uses it as extra memory; never delete it.`,
      steps: [
        'Usually leave it to Windows. Only if C: is very tight and the PC has plenty of memory:',
        'Settings > System > About > Advanced system settings > Performance: Settings > Advanced > Virtual memory: Change.',
        'Untick "Automatically manage", choose C:, Custom size (for example 4096 to 8192 MB), Set, then restart.',
      ],
      risk: 'Too small a page file can make apps crash when memory runs out, and stops crash dumps from being saved.',
      undo: 'Tick "Automatically manage paging file size for all drives" again and restart.',
      estimatedBytes: null,
    })
  }

  if (walk !== null) {
    const programs = walk.protectedRoots
      .filter(r => /\\program files( \(x86\))?$/i.test(r.path))
      .reduce((s, r) => s + r.bytes, 0)
    if (programs >= 20 * GB) {
      out.push({
        id: 'installed_apps',
        title: 'Uninstall apps and games you no longer use',
        severity: 'suggested',
        evidence: `Installed programs (Program Files) use ${sizeText(programs)}. Drive Cleanup never removes programs.`,
        steps: [
          'Open Settings > Apps > Installed apps, and choose Sort by: Size (large to small).',
          'Uninstall what you no longer use (… > Uninstall). Games: uninstall from Steam, Xbox or Epic, which can also move them to another drive.',
        ],
        risk: 'Low. Some apps keep their settings in your profile; reinstalling brings the app back.',
        undo: 'Install the app again.',
        estimatedBytes: null,
      })
    }
    const ost = walk.largest.filter(f => /\.ost$/i.test(f.path) && f.bytes >= 5 * GB)
    if (ost.length > 0) {
      out.push({
        id: 'outlook_mailbox',
        title: 'Keep less mail on this PC (Outlook)',
        severity: 'info',
        evidence: `Outlook's offline mailbox copy uses ${sizeText(ost.reduce((s, f) => s + f.bytes, 0))}.`,
        steps: [
          'Classic Outlook: File > Account Settings > Account Settings > select the account > Change.',
          'Move "Download email for the past" to 1 year (or less), Next, Done, and restart Outlook.',
          'Older mail stays on the server and is searched online.',
        ],
        risk: 'Low. The file may only shrink after Outlook trims it (or after File > Account Settings > Data Files > Settings > Compact Now).',
        undo: 'Move the slider back to All.',
        estimatedBytes: null,
      })
    }
  }

  return out
}
