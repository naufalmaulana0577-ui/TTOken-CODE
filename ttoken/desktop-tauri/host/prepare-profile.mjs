/**
 * Create the Desktop profile on first launch, as the Electron shell's DesktopProjectManager does.
 *
 * The shell runs this with the bundled Node, `--input-type=module --eval`, and the payload project as the working
 * directory, so the imports resolve to the payload's own packages. The only argument is the profile directory.
 * The bundle list comes from the payload project's `dsh.profile.bundles`, written there when the payload was built.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initProfile, removeLinkProjections } from '@deepseek-ai/dsh-app-boot'

const profile = process.argv[1]
if (profile === undefined || profile === '') throw new Error('prepare-profile: the profile directory argument is missing')
const project = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
const bundles = project.dsh?.profile?.bundles
if (!Array.isArray(bundles) || bundles.length === 0) {
  throw new Error('prepare-profile: the payload project lists no profile bundles')
}
mkdirSync(profile, { recursive: true, mode: 0o700 })
initProfile(profile, bundles)
removeLinkProjections(profile)
