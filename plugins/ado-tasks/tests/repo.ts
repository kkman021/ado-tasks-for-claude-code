/** The repository the tests stand in: a POSIX root, so it is absolute on every host. */
export const CWD = '/repo'

/**
 * A path an fs hook receives, as the tests key it. Windows resolves CWD against the current
 * drive (`C:\repo\...`), so the drive letter is dropped and backslashes become slashes.
 */
export function repoPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
}
