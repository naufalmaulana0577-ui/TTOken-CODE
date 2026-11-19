import { describe, expect, it, vi } from 'vitest'
import {
  claimDesktopSingleInstance, INSTALLER_QUIT_ARGUMENT, type DesktopSingleInstanceApplication,
} from '../src/single-instance.ts'

type SecondInstanceListener = (event: unknown, argv: readonly string[]) => void

function primaryApplication(): { application: DesktopSingleInstanceApplication; launch: SecondInstanceListener } {
  let secondInstance: SecondInstanceListener | undefined
  const application = {
    requestSingleInstanceLock: () => true,
    quit: vi.fn(),
    on: vi.fn((_event: 'second-instance', listener: SecondInstanceListener) => { secondInstance = listener }),
  } satisfies DesktopSingleInstanceApplication
  return { application, launch: (event, argv) => { secondInstance?.(event, argv) } }
}

describe('desktop single-instance ownership', () => {
  it('quits a second process without registering lifecycle work', () => {
    const quit = vi.fn()
    const on = vi.fn()
    const application = {
      requestSingleInstanceLock: () => false,
      quit,
      on,
    } satisfies DesktopSingleInstanceApplication

    expect(claimDesktopSingleInstance(application, ['app.exe'], vi.fn(), vi.fn())).toBe(false)
    expect(quit).toHaveBeenCalledOnce()
    expect(on).not.toHaveBeenCalled()
  })

  it('routes a later launch to the primary process', () => {
    const { application, launch } = primaryApplication()
    const focus = vi.fn()
    const quitOwner = vi.fn()

    expect(claimDesktopSingleInstance(application, ['app.exe'], focus, quitOwner)).toBe(true)
    launch({}, ['app.exe'])
    expect(focus).toHaveBeenCalledOnce()
    expect(quitOwner).not.toHaveBeenCalled()
  })

  it('quits the primary process when the installer launches the application to close it', () => {
    const { application, launch } = primaryApplication()
    const focus = vi.fn()
    const quitOwner = vi.fn()

    expect(claimDesktopSingleInstance(application, ['app.exe'], focus, quitOwner)).toBe(true)
    launch({}, ['app.exe', INSTALLER_QUIT_ARGUMENT])
    expect(quitOwner).toHaveBeenCalledOnce()
    expect(focus).not.toHaveBeenCalled()
  })

  it('exits without starting when the installer request finds no running application', () => {
    const quit = vi.fn()
    const on = vi.fn()
    const application = {
      requestSingleInstanceLock: () => true,
      quit,
      on,
    } satisfies DesktopSingleInstanceApplication

    expect(claimDesktopSingleInstance(application, ['app.exe', INSTALLER_QUIT_ARGUMENT], vi.fn(), vi.fn())).toBe(false)
    expect(quit).toHaveBeenCalledOnce()
    expect(on).not.toHaveBeenCalled()
  })
})
