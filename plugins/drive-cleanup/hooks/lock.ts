// One flag shared by the scan and the cleanup: a scan must not walk a drive
// while files are being moved, and a cleanup must not act on a scan that is
// being rewritten.

let cleanupBusy = false

export function isCleanupBusy(): boolean {
  return cleanupBusy
}

export function setCleanupBusy(value: boolean): void {
  cleanupBusy = value
}
