import type { Register } from 'claude-code'
import { atom, read } from 'claude-code'
import { percentText, sizeText } from './core/format.ts'
import { isScanRunning, PANE_ID, requestCancel, startScan } from './scan.ts'
import { answerTool, internalFailure, TOOL_NAMES, TOOL_SPECS } from './tools.ts'

// Drive Cleanup's hooks module: Claude's read-only tools, and the pane beside
// the chat. Nothing here deletes or moves anything (M1 is read-only).

const progressAtom = atom({ plugin: 'drive-cleanup', key: 'progress' } as const, null, {
  shape: 'progress-1',
})
const summaryAtom = atom({ plugin: 'drive-cleanup', key: 'summary' } as const, null, {
  shape: 'summary-1',
})

const STEP_MARK = { pending: '·', running: '…', ok: '✓', not_checked: '!' } as const

const seconds = (ms: number): string => `${String(Math.round(ms / 1000))} s`

const bar = (share: number, width: number): string => {
  const filled = Math.max(0, Math.min(width, Math.round(share * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
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

  // One hook per tool, each named literally.
  on('tool.call', { tool: 'mcp__drive-cleanup__self_check' }, ($, e) =>
    answerTool($, 'self_check', e),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__drive-cleanup__run_deep_scan' }, ($, e) =>
    answerTool($, 'run_deep_scan', e),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__drive-cleanup__get_scan_status' }, ($, e) =>
    answerTool($, 'get_scan_status', e),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__drive-cleanup__get_storage_summary' }, ($, e) =>
    answerTool($, 'get_storage_summary', e),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__drive-cleanup__get_largest_files' }, ($, e) =>
    answerTool($, 'get_largest_files', e),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__drive-cleanup__get_findings' }, ($, e) =>
    answerTool($, 'get_findings', e),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__drive-cleanup__get_windows_recommendations' }, ($, e) =>
    answerTool($, 'get_windows_recommendations', e),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__drive-cleanup__generate_audit_reports' }, ($, e) =>
    answerTool($, 'generate_audit_reports', e),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__drive-cleanup__open_pane' }, ($, e) =>
    answerTool($, 'open_pane', e),
  ).catch(internalFailure)

  // The pane: drive usage, scan progress with Cancel and Retry, recoverable space.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const progress = await read($, progressAtom)
    const summary = await read($, summaryAtom)
    const isRunning = progress?.state === 'running' && isScanRunning()
    const width = Math.min(24, Math.max(6, e.props.bodyColumns - 30))

    return (
      <Box flexDirection="column" gap={1}>
        {summary === null ? (
          <Text dimColor>No deep scan yet. Run one to see where the space on C: went.</Text>
        ) : (
          <Box flexDirection="column">
            {summary.drive !== null && (
              <Text>
                <Text weight="bold">{summary.drive.letter}</Text>{' '}
                {bar(1 - summary.drive.freeBytes / Math.max(1, summary.drive.totalBytes), width)}{' '}
                {sizeText(summary.drive.freeBytes)} free ({percentText(summary.drive.freeBytes, summary.drive.totalBytes)})
              </Text>
            )}
            <Text>A. Safe to clean: {sizeText(summary.recoverable.safeBytes)}</Text>
            <Text>B. Review first: {sizeText(summary.recoverable.reviewBytes)}</Text>
            <Text dimColor>Windows-managed (manual): {sizeText(summary.recoverable.manualBytes)}</Text>
            {summary.top.map(t => (
              <Text dimColor>
                • {t.label}: {sizeText(t.bytes)} ({String(t.count)})
              </Text>
            ))}
            {summary.isPartial && <Text color="warning">Partial scan: some steps were not completed.</Text>}
            {summary.lastAuditFolder !== null && <Text dimColor>Reports: {summary.lastAuditFolder}</Text>}
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
                    label={`Retry ${s.label}`}
                    onPress={() => {
                      void startScan($, s.id).catch(() => undefined)
                    }}
                  />
                ))}
          </Box>
        )}

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
            label="Run deep scan"
            variant="primary"
            onPress={() => {
              void startScan($).catch(() => undefined)
            }}
          />
        )}
        <Text dimColor>Drive Cleanup only reads: it changes nothing on this PC.</Text>
      </Box>
    )
  })
}
