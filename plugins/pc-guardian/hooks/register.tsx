import type { Register } from 'claude-code'
import { atom, read } from 'claude-code'
import { CleanupStateSchema, configureZod, runSummary, TOOL_NAMES, TOOL_SPECS, toolInputJsonSchema } from './deps.js'
import { cancelActiveAudit, startAudit, startRecheck } from './audit.ts'
import { startCleanupFromPane } from './cleanup.ts'
import { proposeCleanup, PROPOSE_SPEC, PROPOSE_TOOL } from './propose.ts'
import {
  bar,
  isRetryable,
  scoreColor,
  scoreWord,
  seconds,
  STEP_MARK,
  STEP_WORD,
  timeText,
  trendText,
} from './pane-format.ts'
import { answerTool, internalFailure, PANE_ID } from './tools.ts'

// The engine reads $.state keys statically, file by file: each file that
// reads or writes a value declares its atom itself. Every declaration of a
// key must match (a test checks): see ../types/index.d.ts for the contract.
const summaryAtom = atom({ plugin: 'pc-guardian', key: 'summary' } as const, null, {
  shape: 'summary-3',
})
const progressAtom = atom({ plugin: 'pc-guardian', key: 'progress' } as const, null, {
  shape: 'progress-3',
})
const cleanupAtom = atom({ plugin: 'pc-guardian', key: 'cleanup' } as const, null, {
  shape: 'cleanup-2',
})

// A hooks module has no code generation guarantees; keep zod on its interpreter path.
configureZod({ jitless: true })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const name of TOOL_NAMES) {
      await $.tool.register({
        name,
        description: TOOL_SPECS[name].description,
        inputSchema: toolInputJsonSchema(name),
      })
    }
    // The one tool that can change the PC, and only on the person's yes (propose.ts).
    await $.tool.register({ name: PROPOSE_TOOL, ...PROPOSE_SPEC })
    return next(e)
  })

  // One hook per tool, each named literally. Every answer is a summary and JSON;
  // a hook that fails answers with the standard error instead.
  on('tool.call', { tool: 'mcp__pc-guardian__self_check' }, ($, e, next) =>
    answerTool($, 'self_check', e, next.signal),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__pc-guardian__run_full_audit' }, ($, e, next) =>
    answerTool($, 'run_full_audit', e, next.signal),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__pc-guardian__get_system_performance' }, ($, e, next) =>
    answerTool($, 'get_system_performance', e, next.signal),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__pc-guardian__get_startup_apps' }, ($, e, next) =>
    answerTool($, 'get_startup_apps', e, next.signal),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__pc-guardian__get_storage_analysis' }, ($, e, next) =>
    answerTool($, 'get_storage_analysis', e, next.signal),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__pc-guardian__get_browser_diagnostics' }, ($, e, next) =>
    answerTool($, 'get_browser_diagnostics', e, next.signal),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__pc-guardian__get_security_status' }, ($, e, next) =>
    answerTool($, 'get_security_status', e, next.signal),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__pc-guardian__get_stability_status' }, ($, e, next) =>
    answerTool($, 'get_stability_status', e, next.signal),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__pc-guardian__get_health_score' }, ($, e, next) =>
    answerTool($, 'get_health_score', e, next.signal),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__pc-guardian__get_recommendations' }, ($, e, next) =>
    answerTool($, 'get_recommendations', e, next.signal),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__pc-guardian__generate_report' }, ($, e, next) =>
    answerTool($, 'generate_report', e, next.signal),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__pc-guardian__get_scan_history' }, ($, e, next) =>
    answerTool($, 'get_scan_history', e, next.signal),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__pc-guardian__compare_scans' }, ($, e, next) =>
    answerTool($, 'compare_scans', e, next.signal),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__pc-guardian__open_dashboard' }, ($, e, next) =>
    answerTool($, 'open_dashboard', e, next.signal),
  ).catch(internalFailure)
  on('tool.call', { tool: 'mcp__pc-guardian__propose_cleanup' }, ($, e) => proposeCleanup($, e)).catch(internalFailure)
  on('tool.call', { tool: 'mcp__pc-guardian__get_cleanup_preview' }, ($, e, next) =>
    answerTool($, 'get_cleanup_preview', e, next.signal),
  ).catch(internalFailure)

  // The dashboard pane: the latest score, live scan progress, quick wins.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const summary = await read($, summaryAtom)
    const progress = await read($, progressAtom)
    const isRunning = progress?.state === 'running'
    const cleanupRead = CleanupStateSchema.safeParse(await read($, cleanupAtom))
    const cleanup = cleanupRead.success ? cleanupRead.data : null
    const isCleaning = cleanup !== null && cleanup.status !== 'idle'
    const barWidth = Math.min(24, Math.max(6, e.props.bodyColumns - 28))

    return (
      <Box flexDirection="column" gap={1}>
        {summary === null ? (
          <Text dimColor>No scan yet. Run a scan to see this PC's Health Score.</Text>
        ) : (
          <Box flexDirection="column">
            <Text>
              <Text weight="bold" color={scoreColor(summary.overall)}>
                {summary.overall === null ? 'No score' : `Health Score ${String(summary.overall)}/100`}
              </Text>
              {summary.bandLabel === null ? '' : ` · ${summary.bandLabel}`}
            </Text>
            {summary.isPartial && <Text color="warning">Partial scan: some areas could not be checked.</Text>}
            {summary.capNote !== null && <Text color="error">{summary.capNote}: a critical security finding.</Text>}
            <Text dimColor>
              Scanned {timeText(summary.createdAt)} in {String(summary.durationSeconds)} s
              {summary.trend.length > 1 ? ` · trend ${trendText(summary.trend)}` : ''}
            </Text>
            {summary.rechecks.length > 0 && <Text dimColor>{summary.rechecks.join('; ')}.</Text>}
          </Box>
        )}

        {summary !== null && (
          <Box flexDirection="column">
            {summary.categories.map(c => (
              <Text>
                {c.label.padEnd(19).slice(0, 19)} <Text color={scoreColor(c.score)}>{bar(c.score, barWidth)}</Text>{' '}
                {c.score === null ? 'not checked' : `${String(c.score).padStart(3)} ${scoreWord(c.score)}`}
              </Text>
            ))}
          </Box>
        )}

        {progress !== null && (isRunning || progress.finishedAt !== null) && (
          <Box flexDirection="column">
            <Text weight="bold">
              {isRunning ? 'Scanning' : 'Last scan'}
              {isRunning ? ` · ${seconds(Date.now() - progress.startedAt)} so far` : ''}
            </Text>
            {progress.steps.map(step => (
              <Text dimColor={step.state === 'pending'} color={step.state === 'not_checked' ? 'warning' : undefined}>
                {STEP_MARK[step.state]} {step.label.padEnd(19).slice(0, 19)} {STEP_WORD[step.state]}
                {step.durationMs === null ? '' : ` (${seconds(step.durationMs)})`}
                {step.notChecked === null ? '' : `: ${step.notChecked.detail}`}
              </Text>
            ))}
            <Text dimColor>{progress.message}</Text>
            {!isRunning &&
              progress.steps
                .filter(s => s.id !== 'score' && isRetryable(s.notChecked?.reason))
                .map(s => (
                  <Button
                    key={`retry-${s.id}`}
                    label={`Retry ${s.label}`}
                    onPress={() => {
                      if (s.id !== 'score') startRecheck($, s.id)
                    }}
                  />
                ))}
          </Box>
        )}

        {summary !== null && summary.quickWins.length > 0 && (
          <Box flexDirection="column">
            <Text weight="bold">Quick wins</Text>
            {summary.quickWins.map(w => (
              <Text>• {w.title}</Text>
            ))}
            <Text dimColor>
              {String(summary.counts.critical)} critical · {String(summary.counts.recommended)} recommended ·{' '}
              {String(summary.counts.optional)} optional. Ask Claude about any of them.
            </Text>
          </Box>
        )}

        <Box flexDirection="row" gap={1}>
          {isRunning ? (
            <Button
              key="cancel"
              label="Cancel scan"
              onPress={() => {
                cancelActiveAudit()
              }}
            />
          ) : (
            <Box flexDirection="row" gap={1}>
              <Button
                key="run"
                label="Run scan"
                variant="primary"
                onPress={() => {
                  startAudit($, {})
                }}
              />
              {!isCleaning && (
                <Button
                  key="cleanup"
                  label="Clean up…"
                  onPress={() => {
                    startCleanupFromPane($)
                  }}
                />
              )}
            </Box>
          )}
        </Box>
        {cleanup !== null && cleanup.status !== 'idle' && (
          <Text color="warning">
            {cleanup.status === 'checking' ? 'Checking what can be cleaned…' : (cleanup.message ?? 'Cleaning…')}
          </Text>
        )}
        {cleanup?.status === 'idle' && cleanup.lastRun !== null && (
          <Text dimColor>Last cleanup: {runSummary(cleanup.lastRun)}</Text>
        )}
        <Text dimColor>PC Guardian reads only. It changes something only when you clean up and confirm.</Text>
      </Box>
    )
  })
}
