// Developer caches (PLAN.md §5.2). Fixed locations per tool; the same ids and
// roots are written into ps/scan/dev-caches.ps1 and ps/actions/clean-cache.ps1
// (a test checks the three agree). Class A caches are cleaned by deleting their
// contents while the tool is closed; class B ones are manual, with the tool's
// own command.

export type DevCacheSpec = {
  id: string
  tool: string
  label: string
  cls: 'safe' | 'review'
  /** How it is cleaned: by Drive Cleanup (A only), or the manual command. */
  how: string
  /** What the person loses or pays by cleaning it. */
  note: string
}

export const DEV_CACHES: readonly DevCacheSpec[] = [
  {
    id: 'npm_cache',
    tool: 'npm',
    label: 'npm cache',
    cls: 'safe',
    how: 'Drive Cleanup deletes its contents while Node.js is not running (same as npm cache clean --force).',
    note: 'Packages are downloaded again when next installed.',
  },
  {
    id: 'npm_npx',
    tool: 'npm',
    label: 'npx cache',
    cls: 'safe',
    how: 'Drive Cleanup deletes its contents while Node.js is not running.',
    note: 'npx downloads a tool again the next time it runs.',
  },
  {
    id: 'npm_logs',
    tool: 'npm',
    label: 'npm logs',
    cls: 'safe',
    how: 'Drive Cleanup deletes its contents while Node.js is not running.',
    note: 'Old npm debug logs only.',
  },
  {
    id: 'yarn_cache',
    tool: 'Yarn',
    label: 'Yarn 1 cache',
    cls: 'safe',
    how: 'Drive Cleanup deletes its contents while Yarn and Node.js are not running (same as yarn cache clean).',
    note: 'Packages are downloaded again when next installed.',
  },
  {
    id: 'yarn_berry',
    tool: 'Yarn',
    label: 'Yarn Berry global cache',
    cls: 'safe',
    how: 'Drive Cleanup deletes its contents while Yarn and Node.js are not running.',
    note: "A project's own .yarn\\cache is never touched.",
  },
  {
    id: 'pip_cache',
    tool: 'pip',
    label: 'pip cache',
    cls: 'safe',
    how: 'Drive Cleanup deletes its contents while Python is not running (same as pip cache purge).',
    note: 'Wheels are downloaded again when next installed.',
  },
  {
    id: 'nuget_http',
    tool: 'NuGet',
    label: 'NuGet HTTP cache',
    cls: 'safe',
    how: 'Drive Cleanup deletes its contents while dotnet, Visual Studio and MSBuild are not running.',
    note: 'Package metadata is downloaded again.',
  },
  {
    id: 'nuget_plugins',
    tool: 'NuGet',
    label: 'NuGet plugins cache',
    cls: 'safe',
    how: 'Drive Cleanup deletes its contents while dotnet, Visual Studio and MSBuild are not running.',
    note: 'Re-created as needed.',
  },
  {
    id: 'vscode_cache',
    tool: 'VS Code',
    label: 'VS Code caches and logs',
    cls: 'safe',
    how: 'Drive Cleanup deletes the contents of Cache, CachedData, CachedExtensionVSIXs, Code Cache, GPUCache and logs while VS Code is closed.',
    note: 'Settings, extensions and workspaces are never touched. VS Code may start a little slower once.',
  },
  {
    id: 'antigravity_cache',
    tool: 'Antigravity',
    label: 'Antigravity caches and logs',
    cls: 'safe',
    how: 'Drive Cleanup deletes the contents of the same cache folders as VS Code while Antigravity is closed.',
    note: 'Locations assumed from VS Code’s layout; confirm on a real install (PLAN.md D5).',
  },
  {
    id: 'pnpm_store',
    tool: 'pnpm',
    label: 'pnpm store',
    cls: 'review',
    how: 'Manual: run pnpm store prune.',
    note: "Deleting the store by hand breaks projects' node_modules, which link into it.",
  },
  {
    id: 'pnpm_cache',
    tool: 'pnpm',
    label: 'pnpm metadata cache',
    cls: 'review',
    how: 'Manual: run pnpm store prune.',
    note: 'Re-created as needed.',
  },
  {
    id: 'gradle_caches',
    tool: 'Gradle',
    label: 'Gradle caches',
    cls: 'review',
    how: 'Manual: delete it with Gradle stopped (gradle --stop), or let Gradle clean old entries itself.',
    note: 'Offline builds need it; dependencies are downloaded again.',
  },
  {
    id: 'gradle_wrapper',
    tool: 'Gradle',
    label: 'Gradle wrapper distributions',
    cls: 'review',
    how: 'Manual: delete versions under wrapper\\dists that no project uses.',
    note: 'Each project downloads its wrapper version again.',
  },
  {
    id: 'maven_repo',
    tool: 'Maven',
    label: 'Maven local repository',
    cls: 'review',
    how: 'Manual: mvn dependency:purge-local-repository in a project, or delete with care.',
    note: 'Every dependency is downloaded again; offline builds fail until then.',
  },
  {
    id: 'nuget_packages',
    tool: 'NuGet',
    label: 'NuGet global packages',
    cls: 'review',
    how: 'Manual: dotnet nuget locals global-packages --clear.',
    note: 'Packages are downloaded again on the next restore.',
  },
  {
    id: 'docker_data',
    tool: 'Docker',
    label: 'Docker Desktop data disk',
    cls: 'review',
    how: 'Manual: docker system df, then docker builder prune and docker image prune; Docker Desktop > Troubleshoot > Clean / Purge data.',
    note: 'Drive Cleanup never runs Docker commands. The disk file does not shrink until Docker compacts it.',
  },
] as const

export const devCache = (id: string): DevCacheSpec | undefined => DEV_CACHES.find(c => c.id === id)

export const SAFE_CACHE_IDS = DEV_CACHES.filter(c => c.cls === 'safe').map(c => c.id)
