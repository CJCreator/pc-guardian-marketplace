import type { EngineInterface } from 'claude-code'
import { writeDataFileVia, type WriteResult } from './deps.js'

/**
 * The only place PC Guardian writes a file. The policy (only inside
 * %APPDATA%\pc-guardian-ai, never through a link) is writeDataFileVia in
 * core, unit-tested there; this adapts it to the engine's `$`.
 */
export async function writeDataFile($: EngineInterface, relativePath: string, text: string): Promise<WriteResult> {
  return writeDataFileVia(
    {
      appData: () => $.env.get('APPDATA'),
      exists: path => $.fs.exists(path),
      stat: path => $.fs.stat(path, { resolve: true }),
      write: (path, contents) => $.fs.write(path, contents),
    },
    relativePath,
    text,
  )
}
