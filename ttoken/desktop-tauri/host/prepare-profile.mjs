/**
 * Create the Desktop profile on first launch, as the Electron shell's DesktopProjectManager does.
 *
 * The shell runs this with the bundled Node, `--input-type=module --eval`, and the payload project as the working
 * directory, so the imports resolve to the payload's own packages. The only argument is the profile directory.
 * The bundle list is the `web` profile template of `@deepseek-ai/dsh-official-bundles`, the list Electron's
 * `createPluginProfile` passes to `initProfile`; a packaged project's manifest does not carry it.
 */

import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { initProfile, removeLinkProjections } from '@deepseek-ai/dsh-app-boot'

/**
 * Import a package of the payload project. A packaged project nests some dependencies under the package that owns
 * them instead of hoisting them, so resolution falls back to the owner's directory.
 */
async function importFromPayload(name, owner) {
  try {
    return await import(name)
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    const ownerRequire = createRequire(fileURLToPath(import.meta.resolve(owner)))
    return import(pathToFileURL(ownerRequire.resolve(name)).href)
  }
}

const profile = process.argv[1]
if (profile === undefined || profile === '') throw new Error('prepare-profile: the profile directory argument is missing')
const { PROFILE_TEMPLATES } = await importFromPayload('@deepseek-ai/dsh-official-bundles', '@deepseek-ai/dsh-app-boot')
const bundles = PROFILE_TEMPLATES?.web?.bundles
if (!Array.isArray(bundles) || bundles.length === 0) {
  throw new Error('prepare-profile: @deepseek-ai/dsh-official-bundles has no web profile template')
}
mkdirSync(profile, { recursive: true, mode: 0o700 })
initProfile(profile, bundles)
removeLinkProjections(profile)
