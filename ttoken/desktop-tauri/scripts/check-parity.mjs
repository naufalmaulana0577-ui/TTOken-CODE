/**
 * Fail when the Electron shell offers a DESKTOP_IPC channel or preload global that ttoken/desktop-tauri/PARITY.md
 * does not list, so upstream additions to the shell or its bridge cannot go unnoticed.
 *
 * Usage: node ttoken/desktop-tauri/scripts/check-parity.mjs
 *
 * Channels come from the DESKTOP_IPC object in apps/desktop/src/ipc.ts, globals from contextBridge.exposeInMainWorld
 * calls in apps/desktop/src/preload-*.ts. PARITY.md lists each as the first, backticked cell of a table row. Rows for
 * names that upstream no longer has are reported as warnings.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..', '..')
const source = join(root, 'apps', 'desktop', 'src')

const ipc = readFileSync(join(source, 'ipc.ts'), 'utf8')
const block = /export const DESKTOP_IPC = \{([\s\S]*?)\n\} as const/u.exec(ipc)?.[1]
if (block === undefined) throw new Error('check-parity: DESKTOP_IPC is missing from apps/desktop/src/ipc.ts')
const channels = [...block.matchAll(/^\s+([A-Za-z0-9]+):/gmu)].map(match => match[1])

const globals = new Set()
for (const file of readdirSync(source).filter(name => name.startsWith('preload') && name.endsWith('.ts'))) {
  for (const match of readFileSync(join(source, file), 'utf8').matchAll(/exposeInMainWorld\(\s*'([^']+)'/gu)) globals.add(match[1])
}

const parity = readFileSync(join(import.meta.dirname, '..', 'PARITY.md'), 'utf8')
const listed = new Set([...parity.matchAll(/^\|\s*`([^`]+)`\s*\|/gmu)].map(match => match[1]))
const upstream = [...channels, ...globals]
const missing = upstream.filter(name => !listed.has(name))
const removed = [...listed].filter(name => /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) && !upstream.includes(name))

console.log(`check-parity: ${channels.length} DESKTOP_IPC channels and ${globals.size} preload globals upstream`)
for (const name of removed) console.warn(`check-parity: PARITY.md lists ${name}, which upstream no longer has`)
if (missing.length > 0) {
  console.error(`check-parity: PARITY.md does not list ${missing.join(', ')}; add a row with its Tauri plan`)
  process.exit(1)
}
