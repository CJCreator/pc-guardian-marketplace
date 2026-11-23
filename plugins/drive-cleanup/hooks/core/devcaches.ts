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
  /** The finding's category when it is not a developer cache. */
  category?: 'browser_cache'
}

const browser = (id: string, tool: string): DevCacheSpec => ({
  id,
  tool,
  label: `${tool} cache`,
  cls: 'safe',
  how: `Drive Cleanup deletes only the cache folders of each ${tool} profile, while ${tool} is closed.`,
  note: 'History, passwords, cookies and settings are untouched; sites load a little slower at first.',
  category: 'browser_cache',
})

/** Browser caches, measured with the developer caches by ps/scan/dev-caches.ps1. */
export const BROWSER_CACHES: readonly DevCacheSpec[] = [
  browser('edge_cache', 'Edge'),
  browser('chrome_cache', 'Chrome'),
  browser('brave_cache', 'Brave'),
  browser('firefox_cache', 'Firefox'),
]

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
    how: 'Manual: docker system df to see what uses it, then docker builder prune and docker image prune (and docker container prune for stopped containers). Avoid "Clean / Purge data" in Troubleshoot unless you mean it: it deletes every image, container and volume, including databases kept in volumes.',
    note: 'Drive Cleanup never runs Docker commands. The disk file keeps its size after pruning until it is compacted (see the virtual disks advice).',
  },
  {
    id: 'cursor_cache',
    tool: 'Cursor',
    label: 'Cursor caches and logs',
    cls: 'safe',
    how: 'Drive Cleanup deletes the contents of the same cache folders as VS Code while Cursor is closed.',
    note: 'Settings, extensions and chats are never touched. Cursor may start a little slower once.',
  },
  {
    id: 'windsurf_cache',
    tool: 'Windsurf',
    label: 'Windsurf caches and logs',
    cls: 'safe',
    how: 'Drive Cleanup deletes the contents of the same cache folders as VS Code while Windsurf is closed.',
    note: 'Settings and extensions are never touched.',
  },
  {
    id: 'jetbrains_caches',
    tool: 'JetBrains IDEs',
    label: 'JetBrains IDE caches',
    cls: 'review',
    how: 'Manual: in the IDE, File > Invalidate Caches…; for old IDE versions, JetBrains Toolbox > the IDE > Settings > "Delete old IDE data", or delete that version\'s folder under %LOCALAPPDATA%\\JetBrains.',
    note: 'Indexes are rebuilt when a project opens (slow once).',
  },
  {
    id: 'cargo_registry',
    tool: 'Rust',
    label: 'Cargo registry (downloaded crates)',
    cls: 'review',
    how: 'Manual: cargo install cargo-cache, then cargo cache --autoclean. Build output (target folders) is offered in the project build caches.',
    note: 'Crates are downloaded again on the next build.',
  },
  {
    id: 'go_build',
    tool: 'Go',
    label: 'Go build cache',
    cls: 'review',
    how: 'Manual: go clean -cache',
    note: 'The next builds are slower once.',
  },
  {
    id: 'go_modcache',
    tool: 'Go',
    label: 'Go module cache',
    cls: 'review',
    how: 'Manual: go clean -modcache',
    note: 'Modules are downloaded again when needed.',
  },
  {
    id: 'conda_pkgs',
    tool: 'conda',
    label: 'conda package cache',
    cls: 'review',
    how: 'Manual: conda clean --all',
    note: 'Environments keep working; packages are downloaded again when a new environment needs them.',
  },
  {
    id: 'uv_cache',
    tool: 'uv',
    label: 'uv cache',
    cls: 'review',
    how: 'Manual: uv cache prune (removes what nothing uses), or uv cache clean (everything).',
    note: 'Packages are downloaded again when needed.',
  },
  {
    id: 'huggingface',
    tool: 'Hugging Face',
    label: 'Hugging Face models and datasets',
    cls: 'review',
    how: 'Manual: huggingface-cli delete-cache (pick the models to remove).',
    note: 'A removed model downloads again (often many GB) the next time code uses it.',
  },
  {
    id: 'ollama_models',
    tool: 'Ollama',
    label: 'Ollama models',
    cls: 'review',
    how: 'Manual: ollama list, then ollama rm <model> for each one you no longer use. To keep them elsewhere, set OLLAMA_MODELS to a folder on another drive and restart Ollama.',
    note: 'A removed model downloads again with ollama pull.',
  },
  {
    id: 'lmstudio_models',
    tool: 'LM Studio',
    label: 'LM Studio models',
    cls: 'review',
    how: 'Manual: LM Studio > My Models > delete the ones you no longer use (or change the models folder there to another drive).',
    note: 'A removed model downloads again from LM Studio.',
  },
  {
    id: 'android_images',
    tool: 'Android SDK',
    label: 'Android emulator system images',
    cls: 'review',
    how: 'Manual: Android Studio > Settings > Languages & Frameworks > Android SDK > SDK Platforms > Show Package Details: untick images you no longer use.',
    note: 'Each image is several GB and downloads again if an emulator needs it.',
  },
  {
    id: 'android_avd',
    tool: 'Android emulator',
    label: 'Android virtual devices',
    cls: 'review',
    how: 'Manual: Android Studio > Device Manager > delete emulators you no longer use (or Wipe Data to shrink one).',
    note: "A deleted emulator's apps and data are gone.",
  },
  {
    id: 'playwright_browsers',
    tool: 'Playwright',
    label: 'Playwright browsers',
    cls: 'review',
    how: 'Manual: npx playwright uninstall --all, then npx playwright install in the projects that need it.',
    note: 'Each project re-downloads the browsers it needs.',
  },
  {
    id: 'cypress_cache',
    tool: 'Cypress',
    label: 'Cypress binaries',
    cls: 'review',
    how: 'Manual: npx cypress cache prune (keeps the current version).',
    note: 'Older Cypress versions download again if a project needs them.',
  },
  {
    id: 'iphone_backups',
    tool: 'Apple Devices / iTunes',
    label: 'iPhone and iPad backups',
    cls: 'review',
    how: 'Manual: in the Apple Devices app (or iTunes > Edit > Preferences > Devices), delete backups of devices you no longer have or old ones you do not need.',
    note: 'A deleted backup cannot be restored to a phone. Keep the latest of each device you use.',
  },
  {
    id: 'spotify_cache',
    tool: 'Spotify',
    label: 'Spotify cache',
    cls: 'review',
    how: 'Manual: Spotify > Settings > Storage > Clear cache. Downloaded playlists are listed there too; remove downloads you no longer play offline.',
    note: 'Songs stream again when played.',
  },
  ...BROWSER_CACHES,
] as const

/** Cleaned by clean-cache.ps1 but measured by other steps: the walk (Temp) and the Windows step (Recycle Bin). */
export const OTHER_CLEANABLE_IDS = ['user_temp', 'recycle_bin'] as const

export const devCache = (id: string): DevCacheSpec | undefined => DEV_CACHES.find(c => c.id === id)

export const SAFE_CACHE_IDS = DEV_CACHES.filter(c => c.cls === 'safe').map(c => c.id)

/** Every id clean-cache.ps1 knows. */
export const CLEANABLE_CACHE_IDS = [...SAFE_CACHE_IDS, ...OTHER_CLEANABLE_IDS]
