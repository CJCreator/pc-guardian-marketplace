import type { EngineInterface, Register } from 'claude-code'
import { atom, read } from 'claude-code'
import { CATEGORY_LABEL } from './core/classify.ts'
import { percentText, sizeText } from './core/format.ts'
import type { Finding } from './core/types.ts'
import { ensureCleanupOn, ensureDuplicatesOn } from './consent.ts'
import { isActionable } from './core/propose.ts'
import { cleanSelected, purgeRun, readRunIndex, restoreRun, start } from './cleanup.ts'
import { isScanRunning, loadLatestScan, PANE_ID, requestCancel, startScan } from './scan.ts'
import { loadSettings, saveSettings } from './settings-store.ts'
import { answerTool, internalFailure, TOOL_NAMES, TOOL_SPECS } from './tools.ts'
import { readActivity, readSelection, readView, setActivity, setSelection, setView } from './ui-state.ts'
import { verifyCleanup } from './verify.ts'

// Drive Cleanup's hooks module: Claude's tools, and the pane beside the chat.
// Claude's tools read, except propose_cleanup and restore_quarantine, which
// only ask: nothing changes until the person answers yes in Claude Code's own
// dialog. The pane's buttons, which only the person presses, do the same;
// purging a quarantine is the pane's alone.

const progressAtom = atom({ plugin: 'drive-cleanup', key: 'progress' } as const, null, {
  shape: 'progress-1',
})
const summaryAtom = atom({ plugin: 'drive-cleanup', key: 'summary' } as const, null, {
  shape: 'summary-1',
})

const TAB_LABEL = { overview: 'Overview', review: 'Choose items', quarantine: 'Undo', settings: 'Settings' } as const
const STEP_MARK = { pending: '·', running: '…', ok: '✓', not_checked: '!' } as const
const PAGE_SIZE = 8

const seconds = (ms: number): string => `${String(Math.round(ms / 1000))} s`

const bar = (share: number, width: number): string => {
  const filled = Math.max(0, Math.min(width, Math.round(share * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const isSelectable = (f: Finding): boolean =>
  f.class !== 'protected' && f.protectedBy === null && (f.action === 'delete' || f.action === 'quarantine')

async function toggle($: EngineInterface, scanId: string, ids: readonly string[], on: boolean): Promise<void> {
  await setSelection($, s => {
    const current = new Set(s.scanId === scanId ? s.ids : [])
    for (const id of ids) {
      if (on) current.add(id)
      else current.delete(id)
    }
    return { scanId, ids: [...current] }
  })
}

async function toggleCleanup($: EngineInterface): Promise<void> {
  if ((await loadSettings($)).cleanupEnabled) {
    await saveSettings($, s => ({ ...s, cleanupEnabled: false }))
    await setActivity($, { state: 'idle', message: 'Cleanup is off.' })
    return
  }
  if (await ensureCleanupOn($))
    await setActivity($, {
      state: 'idle',
      message: 'Cleanup is on. Pick items in Choose items, or press Clean safe items on Overview.',
    })
}

async function toggleDuplicates($: EngineInterface): Promise<void> {
  if ((await loadSettings($)).duplicatesEnabled) {
    await saveSettings($, s => ({ ...s, duplicatesEnabled: false }))
    await setActivity($, { state: 'idle', message: 'Duplicate search is off.' })
    return
  }
  if (await ensureDuplicatesOn($)) {
    await setActivity($, { state: 'idle', message: 'Duplicate search is on. It runs with the next deep scan.' })
  }
}

/** One press: every safe item (caches, temporary files) selected, then the usual confirmation. */
async function cleanSafeItems($: EngineInterface): Promise<void> {
  const scan = await loadLatestScan($)
  if (scan === undefined) return
  if (!(await ensureCleanupOn($))) return
  const ids = scan.classified.findings.filter(f => f.class === 'safe' && isActionable(f)).map(f => f.id)
  await setSelection($, () => ({ scanId: scan.meta.scanId, ids }))
  await cleanSelected($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const name of TOOL_NAMES) {
      await $.tool.register({
        name,
        description: TOOL_SPECS[name].description,
        inputSchema: TOOL_SPECS[name].inputSchema,
      })
    }
    return next(e)
  })

  // One hook per tool, each named literally. All read, except the two that ask the person first.
  on('tool.call', { tool: 'mcp__drive-cleanup__self_check' }, ($, e) => answerTool($, 'self_check', e)).catch(
    internalFailure,
  )
  on('tool.call', { tool: 'mcp__drive-cleanup__run_deep_scan' }, ($, e) => answerTool($, 'run_deep_scan', e)).catch(
    internalFailure,
  )
  on('tool.call', { tool: 'mcp__drive-cleanup__get_scan_status' }, ($, e) => answerTool($, 'get_scan_status', e)).catch(
    internalFailure,
  )
  on('tool.call', { tool: 'mcp__drive-cleanup__get_storage_summary' }, ($, e) =>
    answerTool($, 'get_storage_summary', e),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__drive-cleanup__get_largest_files' }, ($, e) =>
    answerTool($, 'get_largest_files', e),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__drive-cleanup__get_findings' }, ($, e) => answerTool($, 'get_findings', e)).catch(
    internalFailure,
  )
  on('tool.call', { tool: 'mcp__drive-cleanup__get_windows_recommendations' }, ($, e) =>
    answerTool($, 'get_windows_recommendations', e),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__drive-cleanup__generate_audit_reports' }, ($, e) =>
    answerTool($, 'generate_audit_reports', e),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__drive-cleanup__get_dev_caches' }, ($, e) => answerTool($, 'get_dev_caches', e)).catch(
    internalFailure,
  )
  on('tool.call', { tool: 'mcp__drive-cleanup__get_duplicate_groups' }, ($, e) =>
    answerTool($, 'get_duplicate_groups', e),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__drive-cleanup__get_quarantine' }, ($, e) => answerTool($, 'get_quarantine', e)).catch(
    internalFailure,
  )
  on('tool.call', { tool: 'mcp__drive-cleanup__get_settings' }, ($, e) => answerTool($, 'get_settings', e)).catch(
    internalFailure,
  )
  on('tool.call', { tool: 'mcp__drive-cleanup__verify_cleanup' }, ($, e) => answerTool($, 'verify_cleanup', e)).catch(
    internalFailure,
  )
  on('tool.call', { tool: 'mcp__drive-cleanup__propose_cleanup' }, ($, e) => answerTool($, 'propose_cleanup', e)).catch(
    internalFailure,
  )
  on('tool.call', { tool: 'mcp__drive-cleanup__restore_quarantine' }, ($, e) =>
    answerTool($, 'restore_quarantine', e),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__drive-cleanup__open_pane' }, ($, e) => answerTool($, 'open_pane', e)).catch(
    internalFailure,
  )

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const view = await readView($)
    const activity = await readActivity($)
    const tabs = (['overview', 'review', 'quarantine', 'settings'] as const).map(name => (
      <Button
        key={`tab-${name}`}
        label={TAB_LABEL[name]}
        variant={view.name === name ? 'primary' : undefined}
        dimColor={view.name !== name}
        onPress={() => {
          void setView($, { name, category: null, page: 0 })
        }}
      />
    ))
    const footer = (
      <Box flexDirection="column">
        {activity.message !== null && (
          <Text color={activity.state === 'working' ? 'warning' : undefined}>{activity.message}</Text>
        )}
      </Box>
    )
    const header = (
      <Box flexDirection="row" gap={1}>
        {tabs}
      </Box>
    )

    // ------------------------------------------------------------ overview
    if (view.name === 'overview') {
      const progress = await read($, progressAtom)
      const summary = await read($, summaryAtom)
      const isRunning = progress?.state === 'running' && isScanRunning()
      const width = Math.min(24, Math.max(6, e.props.bodyColumns - 30))
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {summary === null ? (
            <Text dimColor>
              No deep scan yet. Run one to see where the space on C: went, or ask Claude to "free up space".
            </Text>
          ) : (
            <Box flexDirection="column">
              {summary.drive !== null && (
                <Text>
                  <Text weight="bold">{summary.drive.letter}</Text>{' '}
                  {bar(1 - summary.drive.freeBytes / Math.max(1, summary.drive.totalBytes), width)}{' '}
                  {sizeText(summary.drive.freeBytes)} free (
                  {percentText(summary.drive.freeBytes, summary.drive.totalBytes)})
                </Text>
              )}
              <Text>
                Safe to clean: <Text weight="bold">{sizeText(summary.recoverable.safeBytes)}</Text>
                <Text dimColor> (caches and temporary files; apps rebuild them)</Text>
              </Text>
              <Text>
                Worth a look: <Text weight="bold">{sizeText(summary.recoverable.reviewBytes)}</Text>
                <Text dimColor> (your old files; moved to quarantine, so you can undo)</Text>
              </Text>
              <Text dimColor>
                Windows itself: {sizeText(summary.recoverable.manualBytes)} (ask Claude, or Windows Settings)
              </Text>
              {summary.top.map(t => (
                <Text dimColor>
                  • {t.label}: {sizeText(t.bytes)} ({String(t.count)})
                </Text>
              ))}
              {summary.isPartial && <Text color="warning">Partial scan: some steps were not completed.</Text>}
              {summary.lastAuditFolder !== null && (
                <Text dimColor wrap="truncate-middle">
                  Reports: {summary.lastAuditFolder}
                </Text>
              )}
            </Box>
          )}
          {progress !== null && (
            <Box flexDirection="column">
              <Text weight="bold">
                {isRunning ? `Scanning · ${seconds(Date.now() - progress.startedAt)} so far` : 'Last scan'}
              </Text>
              {progress.steps.map(step => (
                <Text dimColor={step.state === 'pending'} color={step.state === 'not_checked' ? 'warning' : undefined}>
                  {STEP_MARK[step.state]} {step.label}
                  {step.durationMs === null ? '' : ` (${seconds(step.durationMs)})`}
                  {step.isTruncated ? ', partial' : ''}
                  {step.detail === null ? '' : `: ${step.detail}`}
                </Text>
              ))}
              <Text dimColor>{progress.message}</Text>
              {!isRunning &&
                progress.steps
                  .filter(s => s.isRetryable)
                  .map(s => (
                    <Button
                      key={`retry-${s.id}`}
                      label={s.id === 'hash' && s.state === 'ok' ? 'Continue duplicate search' : `Retry ${s.label}`}
                      onPress={() => {
                        void startScan($, s.id).catch(() => {})
                      }}
                    />
                  ))}
            </Box>
          )}
          <Box flexDirection="row" gap={1}>
            {isRunning ? (
              <Button
                key="cancel"
                label="Cancel after this step"
                onPress={() => {
                  requestCancel()
                }}
              />
            ) : (
              <Button
                key="run"
                label={summary === null ? 'Run deep scan' : 'Scan again'}
                variant={summary === null ? 'primary' : undefined}
                onPress={() => {
                  void startScan($).catch(() => {})
                }}
              />
            )}
            {!isRunning && summary !== null && summary.recoverable.safeBytes > 0 && (
              <Button
                key="clean-safe"
                label={`Clean safe items (${sizeText(summary.recoverable.safeBytes)})…`}
                variant="primary"
                onPress={() => {
                  start(() => cleanSafeItems($))
                }}
              />
            )}
            {!isRunning && summary !== null && (
              <Button
                key="verify"
                label="Verify"
                onPress={() => {
                  start(async () => {
                    await setActivity($, { state: 'working', message: 'Verifying…' })
                    const outcome = await verifyCleanup($)
                    await setActivity($, {
                      state: 'idle',
                      message: outcome.status === 'ok' ? `Verified. Report: ${outcome.folder}` : outcome.message,
                    })
                  })
                }}
              />
            )}
          </Box>
          {footer}
          <Text dimColor>Scans only read. Nothing changes until you say yes.</Text>
        </Box>
      )
    }

    // ------------------------------------------------------------ review
    if (view.name === 'review') {
      const scan = await loadLatestScan($)
      const settings = await loadSettings($)
      if (scan === undefined) {
        return (
          <Box flexDirection="column" gap={1}>
            {header}
            <Text dimColor>Run a deep scan first (Overview).</Text>
          </Box>
        )
      }
      const sel = await readSelection($)
      const selected = new Set(sel.scanId === scan.meta.scanId ? sel.ids : [])
      const findings = scan.classified.findings.filter(isSelectable)
      const selectedFindings = findings.filter(f => selected.has(f.id))
      const selectedBytes = selectedFindings.reduce((s, f) => s + f.bytes, 0)
      const bottom = (
        <Box flexDirection="column">
          <Text>
            Selected: {String(selectedFindings.length)} items, {sizeText(selectedBytes)}
          </Text>
          {settings.cleanupEnabled ? (
            <Button
              key="clean"
              label="Clean selected…"
              variant="primary"
              onPress={() => {
                start(() => cleanSelected($))
              }}
            />
          ) : (
            <Button
              key="turn-on-clean"
              label="Turn on cleanup and clean selected…"
              variant="primary"
              onPress={() => {
                start(async () => {
                  if (await ensureCleanupOn($)) await cleanSelected($)
                })
              }}
            />
          )}
        </Box>
      )

      if (view.category === null) {
        const categories = [...new Set(findings.map(f => f.category))]
        return (
          <Box flexDirection="column" gap={1}>
            {header}
            <Text dimColor>
              Caches and temporary files are deleted (apps rebuild them). Your own files are moved to quarantine, so you
              can put them back. Windows and program files are never listed.
            </Text>
            {categories.length === 0 && <Text dimColor>Nothing to clean in the latest scan.</Text>}
            {categories.map(cat => {
              const items = findings.filter(f => f.category === cat)
              const ids = items.map(f => f.id)
              const chosen = items.filter(f => selected.has(f.id))
              const bytes = items.reduce((s, f) => s + f.bytes, 0)
              const cls = items[0]?.class === 'safe' ? 'deleted' : 'restorable'
              return (
                <Box flexDirection="column">
                  <Text>
                    <Text weight="bold">{CATEGORY_LABEL[cat]}</Text> ({cls}) · {String(items.length)} ·{' '}
                    {sizeText(bytes)}
                    {chosen.length > 0 ? ` · ${String(chosen.length)} selected` : ''}
                  </Text>
                  <Box flexDirection="row" gap={1}>
                    <Button
                      key={`show-${cat}`}
                      label="Show items"
                      onPress={() => {
                        void setView($, { category: cat, page: 0 })
                      }}
                    />
                    <Button
                      key={`all-${cat}`}
                      label="Select all"
                      dimColor
                      onPress={() => {
                        void toggle($, scan.meta.scanId, ids, true)
                      }}
                    />
                    <Button
                      key={`none-${cat}`}
                      label="Clear"
                      dimColor
                      onPress={() => {
                        void toggle($, scan.meta.scanId, ids, false)
                      }}
                    />
                  </Box>
                </Box>
              )
            })}
            {bottom}
            {footer}
          </Box>
        )
      }

      const items = findings.filter(f => f.category === view.category)
      const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
      const page = Math.min(view.page, pages - 1)
      const shown = items.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text weight="bold">
            {CATEGORY_LABEL[view.category as Finding['category']] ?? view.category} · page {String(page + 1)} of{' '}
            {String(pages)}
          </Text>
          {shown.map(f => (
            <Box flexDirection="column">
              <Button
                key={`item-${f.id}`}
                label={`${selected.has(f.id) ? '☑' : '☐'} ${sizeText(f.bytes)}  ${f.path}`}
                onPress={() => {
                  void toggle($, scan.meta.scanId, [f.id], !selected.has(f.id))
                }}
              />
              <Text dimColor wrap="truncate-end">
                {f.action === 'delete' ? 'Deleted · ' : 'Moved to quarantine (restorable) · '}
                {f.reason}
              </Text>
            </Box>
          ))}
          <Box flexDirection="row" gap={1}>
            <Button
              key="back"
              label="Back"
              onPress={() => {
                void setView($, { category: null, page: 0 })
              }}
            />
            {page > 0 && (
              <Button
                key="prev"
                label="Previous"
                onPress={() => {
                  void setView($, { page: page - 1 })
                }}
              />
            )}
            {page < pages - 1 && (
              <Button
                key="next"
                label="Next"
                onPress={() => {
                  void setView($, { page: page + 1 })
                }}
              />
            )}
          </Box>
          {bottom}
          {footer}
        </Box>
      )
    }

    // ------------------------------------------------------------ quarantine
    if (view.name === 'quarantine') {
      const index = await readRunIndex($)
      const runs = index.filter(r => r.kind === 'cleanup')
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {runs.length === 0 && <Text dimColor>No cleanups yet.</Text>}
          {runs.slice(0, 12).map(r => (
            <Box flexDirection="column">
              <Text>
                <Text weight="bold">{r.startedAt.slice(0, 16).replace('T', ' ')}</Text> · moved{' '}
                {sizeText(r.quarantinedBytes)} · deleted {sizeText(r.deletedBytes)} · {String(r.skipped)} skipped
              </Text>
              {r.quarantineDir !== null && (
                <Text dimColor wrap="truncate-middle">
                  {r.quarantineState === 'active'
                    ? 'In quarantine: '
                    : r.quarantineState === 'restored'
                      ? 'Restored from: '
                      : r.quarantineState === 'purged'
                        ? 'Deleted for good: '
                        : ''}
                  {r.quarantineDir}
                </Text>
              )}
              {r.quarantineState === 'active' && (
                <Box flexDirection="row" gap={1}>
                  <Button
                    key={`restore-${r.runId}`}
                    label="Restore"
                    onPress={() => {
                      start(() => restoreRun($, r.runId))
                    }}
                  />
                  <Button
                    key={`purge-${r.runId}`}
                    label="Delete for good…"
                    dimColor
                    onPress={() => {
                      start(() => purgeRun($, r.runId))
                    }}
                  />
                </Box>
              )}
            </Box>
          ))}
          <Text dimColor>
            Quarantine keeps your files until you say otherwise. Restore puts them back where they were; Delete for good
            frees their space once you are sure.
          </Text>
          {footer}
        </Box>
      )
    }

    // ------------------------------------------------------------ settings
    const settings = await loadSettings($)
    const scan = await loadLatestScan($)
    const drives = [
      'auto',
      ...(scan?.volume?.drives ?? []).filter(d => /^ntfs$/i.test(d.fileSystem)).map(d => d.letter.toUpperCase()),
    ]
    const nextDrive = drives[(drives.indexOf(settings.quarantineDrive) + 1) % drives.length] ?? 'auto'
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Box flexDirection="column">
          <Text>
            <Text weight="bold">Cleanup:</Text> {settings.cleanupEnabled ? 'on' : 'off'}
          </Text>
          <Button
            key="set-cleanup"
            label={settings.cleanupEnabled ? 'Turn off' : 'Turn on…'}
            onPress={() => {
              start(() => toggleCleanup($))
            }}
          />
        </Box>
        <Box flexDirection="column">
          <Text>
            <Text weight="bold">Duplicate search (reads file contents):</Text>{' '}
            {settings.duplicatesEnabled ? 'on' : 'off'}
          </Text>
          <Text dimColor>
            Files from {sizeText(settings.minDuplicateBytes)} to {sizeText(settings.maxHashBytes)}, in your profile and
            top-level folders.
          </Text>
          <Button
            key="set-dupes"
            label={settings.duplicatesEnabled ? 'Turn off' : 'Turn on…'}
            onPress={() => {
              start(() => toggleDuplicates($))
            }}
          />
        </Box>
        <Box flexDirection="column">
          <Text>
            <Text weight="bold">Quarantine drive:</Text>{' '}
            {settings.quarantineDrive === 'auto'
              ? 'Auto (another drive with room, else the system drive)'
              : settings.quarantineDrive}
          </Text>
          <Button
            key="set-drive"
            label={`Change to ${nextDrive === 'auto' ? 'Auto' : nextDrive}`}
            onPress={() => {
              start(async () => {
                await saveSettings($, s => ({ ...s, quarantineDrive: nextDrive }))
                await setActivity($, {
                  state: 'idle',
                  message: `Quarantine drive: ${nextDrive === 'auto' ? 'Auto' : nextDrive}.`,
                })
              })
            }}
          />
        </Box>
        <Text dimColor>Only you can change these: here, or by answering yes when Claude asks.</Text>
        {footer}
      </Box>
    )
  })
}
