import type { EngineInterface } from 'claude-code'
import { normalizePath } from './core/paths.ts'

// The only place Drive Cleanup writes or reads its own files: inside
// %APPDATA%\techgramam-drive-cleanup, never through a link.

export const DATA_FOLDER_NAME = 'techgramam-drive-cleanup'

export type DataFolder = { status: 'ok'; path: string } | { status: 'refused'; detail: string }

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

export async function dataFolder($: EngineInterface): Promise<DataFolder> {
  const appData = await $.env.get('APPDATA')
  if (appData === undefined) return { status: 'refused', detail: 'APPDATA is not set.' }
  if (!/^[A-Za-z]:\\/.test(appData)) {
    return { status: 'refused', detail: 'APPDATA is not a local absolute path.' }
  }
  return { status: 'ok', path: `${appData.replace(/\\+$/, '')}\\${DATA_FOLDER_NAME}` }
}

/** Checks `relative` (forward slashes) and returns the full path, or why not. */
function resolve(root: string, relative: string): { path: string; chain: string[] } | string {
  const segments = relative.split('/')
  if (segments.length === 0 || segments.some(s => !SEGMENT.test(s) || s.includes('..'))) {
    return `"${relative}" is not a valid data file name.`
  }
  const chain: string[] = [root]
  let current = root
  for (const segment of segments) {
    current = `${current}\\${segment}`
    chain.push(current)
  }
  return { path: current, chain }
}

/** Refuses when any existing part of the path is a link, or the folder is not where expected. */
async function checkChain($: EngineInterface, root: string, chain: string[]): Promise<string | undefined> {
  if (await $.fs.exists(root)) {
    const stat = await $.fs.stat(root, { resolve: true })
    if (stat.isLink || stat.realPath === undefined || normalizePath(stat.realPath) !== normalizePath(root)) {
      return 'The data folder is a link or is not where expected, so nothing was written.'
    }
  }
  for (const part of chain.slice(1)) {
    if (!(await $.fs.exists(part))) break
    const stat = await $.fs.stat(part)
    if (stat.isLink) return 'Part of the path is a link, so nothing was written.'
  }
  return undefined
}

export type WriteResult = { status: 'written'; path: string } | { status: 'refused'; detail: string }

export async function writeDataFile(
  $: EngineInterface,
  relative: string,
  text: string,
): Promise<WriteResult> {
  const folder = await dataFolder($)
  if (folder.status !== 'ok') return folder
  const target = resolve(folder.path, relative)
  if (typeof target === 'string') return { status: 'refused', detail: target }
  try {
    const problem = await checkChain($, folder.path, target.chain)
    if (problem !== undefined) return { status: 'refused', detail: problem }
    await $.fs.write(target.path, text)
    return { status: 'written', path: target.path }
  } catch {
    return { status: 'refused', detail: `${relative} could not be written.` }
  }
}

export async function readDataFile($: EngineInterface, relative: string): Promise<string | undefined> {
  const folder = await dataFolder($)
  if (folder.status !== 'ok') return undefined
  const target = resolve(folder.path, relative)
  if (typeof target === 'string') return undefined
  try {
    if (!(await $.fs.exists(target.path))) return undefined
    if ((await checkChain($, folder.path, target.chain)) !== undefined) return undefined
    return await $.fs.read(target.path)
  } catch {
    return undefined
  }
}
