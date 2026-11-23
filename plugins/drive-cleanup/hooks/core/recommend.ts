// Phase 6 (PLAN.md §8): Windows optimisation, as recommendations only. Each
// has the evidence, manual steps, the risk and how to undo it. Drive Cleanup
// runs none of them.

import { percentText, sizeText } from './format.ts'
import type { RawVolume, RawWindows, RawWindowsItem, Recommendation } from './types.ts'

const GB = 1024 ** 3

const item = (win: RawWindows | null, id: RawWindowsItem['id']): RawWindowsItem | undefined =>
  win?.items.find(i => i.id === id && i.status === 'ok')

export function windowsRecommendations(volume: RawVolume | null, win: RawWindows | null): Recommendation[] {
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
          'Start with class A findings (safe to clean), then review class B.',
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
      title: 'Clean Windows Update files',
      severity: 'suggested',
      evidence: `Windows Update downloads use ${sizeText(updates.bytes)}.`,
      steps: [
        'Open Settings > System > Storage > Temporary files.',
        'Tick "Windows Update Cleanup" (and "Delivery Optimization Files"), then Remove files.',
        'Or: Disk Cleanup > Clean up system files > Windows Update Cleanup.',
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
      steps: ['Disk Cleanup > Clean up system files > tick "System error memory dump files" > OK.'],
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
        'If you never hibernate, in an administrator terminal run: powercfg /h /type reduced',
        'Or turn hibernation off with: powercfg /h off',
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
        steps: ['Open Control Panel > System > System Protection > Configure.', 'Lower "Max Usage" to 5–8 %.'],
        risk: 'Fewer restore points to go back to.',
        undo: 'Raise Max Usage again.',
        estimatedBytes: null,
      })
    }
  }

  return out
}
