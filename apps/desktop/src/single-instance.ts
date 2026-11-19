/** Electron single-instance ownership before any Desktop profile lifecycle begins. */

/**
 * Command-line flag with which the Windows installer asks a running Desktop to quit without the task
 * confirmation; the installer prompt has already warned that running tasks stop.
 */
export const INSTALLER_QUIT_ARGUMENT = '--quit-for-installer'

/** Minimal Electron application operations needed for instance ownership. */
export interface DesktopSingleInstanceApplication {
  requestSingleInstanceLock(): boolean
  quit(): void
  on(event: 'second-instance', listener: (event: unknown, argv: readonly string[]) => void): unknown
}

/**
 * Claim the process-lifetime Desktop lock and route later launches to the owner.
 * A launch carrying `INSTALLER_QUIT_ARGUMENT` never starts the Desktop: a later launch makes the owner quit,
 * and a launch that finds no owner exits at once.
 * @param application - Electron application singleton.
 * @param argv - command line of this process.
 * @param focusOwner - focus or recreate the primary window after a later launch.
 * @param quitOwner - quit the primary process without the task confirmation.
 * @returns true only in the process that may access the Desktop profile.
 */
export function claimDesktopSingleInstance(
  application: DesktopSingleInstanceApplication,
  argv: readonly string[],
  focusOwner: () => void,
  quitOwner: () => void,
): boolean {
  if (!application.requestSingleInstanceLock() || argv.includes(INSTALLER_QUIT_ARGUMENT)) {
    application.quit()
    return false
  }
  application.on('second-instance', (_event, launchArgv) => {
    if (launchArgv.includes(INSTALLER_QUIT_ARGUMENT)) quitOwner()
    else focusOwner()
  })
  return true
}
