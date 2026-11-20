/**
 * Check that the Harness's native addons work under plain Node, the runtime the Tauri shell starts the Host with.
 *
 * Usage: <bundled node> addon-smoke.mjs <payload root> [--json <file>]
 *
 * The payload root holds the project as files at `dsh` and the runtime at `runtime`: the output of
 * extract-payload.mjs for a packaged Electron build, whose `app.asar` plain Node cannot read. Every addon is resolved
 * from the payload project, so the check covers exactly what ships. Each check reports `ok`, `failed`, or
 * `unsupported` (the addon has no build for this platform, by design), with its duration and a short detail. The exit
 * code is 1 when any check failed.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const CHECK_DEADLINE_MS = 15_000

const [root, ...options] = process.argv.slice(2)
if (root === undefined) {
  console.error('usage: node addon-smoke.mjs <payload root> [--json <file>]')
  process.exit(2)
}
const jsonIndex = options.indexOf('--json')
const jsonPath = jsonIndex === -1 ? undefined : options[jsonIndex + 1]
const project = join(root, 'dsh')
if (!existsSync(project)) {
  console.error(existsSync(join(root, 'app.asar'))
    ? `addon-smoke: ${root} keeps the dsh project in app.asar; write it out with extract-payload.mjs first`
    : `addon-smoke: ${root} has no dsh project directory`)
  process.exit(2)
}
const require = createRequire(join(project, 'package.json'))

/**
 * Load a dependency the way the Harness package that owns it does. A packaged payload nests some dependencies under
 * their owner instead of hoisting them to the project, so resolution starts in the owner's directory.
 */
function requireFrom(owner, name) {
  const manifest = join(project, 'node_modules', ...owner.split('/'), 'package.json')
  return (existsSync(manifest) ? createRequire(manifest) : require)(name)
}

/** Outcome of one check, before timing is added. */
class Unsupported extends Error {}

const withDeadline = (promise, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => { reject(new Error(`${label} did not finish within ${CHECK_DEADLINE_MS} ms`)) }, CHECK_DEADLINE_MS).unref()),
])

const checks = {
  /** node-pty opens a pseudo-terminal and reads a command's output from it. */
  async 'node-pty'() {
    const pty = requireFrom('@deepseek-ai/dsh-subprocess-local', 'node-pty')
    const windows = process.platform === 'win32'
    const shell = windows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh'
    const args = windows ? ['/d', '/s', '/c', 'echo ttoken-pty-ok'] : ['-c', 'echo ttoken-pty-ok']
    const terminal = pty.spawn(shell, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: tmpdir(), env: process.env })
    let output = ''
    try {
      await withDeadline(new Promise((resolve) => {
        terminal.onData((data) => {
          output += data
          if (output.includes('ttoken-pty-ok')) resolve()
        })
      }), 'the terminal')
    } finally {
      terminal.kill()
    }
    return `read the marker through ${shell}`
  },

  /** sharp creates, encodes, decodes, and resizes an image. */
  async sharp() {
    const sharp = require('sharp')
    const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#f4efe4' } }).png().toBuffer()
    const resized = await sharp(png).resize(8).png().toBuffer()
    const { width, height, format } = await sharp(resized).metadata()
    if (width !== 8 || height !== 8 || format !== 'png') throw new Error(`unexpected result ${format} ${width}x${height}`)
    return `libvips ${sharp.versions?.vips ?? 'unknown'}`
  },

  /** The system addon takes and releases an exclusive POSIX lock; it ships no Windows build. */
  async 'node-addon-system'() {
    const { tryLockExclusive } = await import(pathToFileURL(require.resolve('@deepseek-ai/node-addon-system/flock')).href)
    const { openSync, closeSync } = await import('node:fs')
    const directory = mkdtempSync(join(tmpdir(), 'ttoken-addon-'))
    const descriptor = openSync(join(directory, 'lock'), 'w')
    try {
      await tryLockExclusive(descriptor)
      return 'flock acquired'
    } catch (error) {
      if (process.platform === 'win32') throw new Unsupported(`no Windows build: ${error.message}`)
      throw error
    } finally {
      closeSync(descriptor)
      rmSync(directory, { recursive: true, force: true })
    }
  },

  /** The ripgrep binary searches a file. */
  async ripgrep() {
    const { rgPath } = requireFrom('@deepseek-ai/dsh-util-ripgrep', '@vscode/ripgrep')
    const directory = mkdtempSync(join(tmpdir(), 'ttoken-rg-'))
    try {
      writeFileSync(join(directory, 'sample.txt'), 'first line\nttoken-rg-marker\n')
      const { stdout } = await withDeadline(run(rgPath, ['--fixed-strings', '--line-number', 'ttoken-rg-marker', directory]), 'ripgrep')
      if (!stdout.includes('2:ttoken-rg-marker')) throw new Error(`unexpected output ${JSON.stringify(stdout)}`)
      const { stdout: version } = await run(rgPath, ['--version'])
      return version.split('\n')[0]
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },

  /** koffi, the FFI the Desktop Host loads, initializes. */
  async koffi() {
    const koffi = require('koffi')
    if (typeof koffi.load !== 'function') throw new Error('koffi.load is missing')
    return `koffi ${koffi.version ?? 'loaded'}`
  },

  /** The `node` launcher package scripts find on PATH runs the bundled Node, not Electron. */
  async 'node launcher'() {
    const launcher = join(root, 'runtime', 'bin', process.platform === 'win32' ? 'node.cmd' : 'node')
    if (!existsSync(launcher)) throw new Error(`${launcher} is missing`)
    const probe = 'console.log(JSON.stringify({ version: process.version, electron: process.versions.electron ?? null, execPath: process.execPath }))'
    const env = { ...process.env, DSH_DESKTOP_NODE_EXECUTABLE: process.execPath }
    // cmd /s drops the first and last quote of the command, so the whole command gets one more pair; the probe
    // itself has no quotes.
    const { stdout } = process.platform === 'win32'
      ? await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${launcher}" -e "${probe}""`], { env, windowsVerbatimArguments: true })
      : await run(launcher, ['-e', probe], { env })
    const reported = JSON.parse(stdout.trim().split('\n').at(-1))
    if (reported.electron !== null) throw new Error(`the launcher started Electron ${reported.electron}`)
    if (reported.version !== process.version) throw new Error(`the launcher started Node ${reported.version}, expected ${process.version}`)
    return `Node ${reported.version}`
  },
}

const results = []
for (const [name, check] of Object.entries(checks)) {
  const started = performance.now()
  let status = 'ok'
  let detail
  try {
    detail = await check()
  } catch (error) {
    status = error instanceof Unsupported ? 'unsupported' : 'failed'
    detail = error instanceof Error ? error.message : String(error)
  }
  const ms = Math.round(performance.now() - started)
  results.push({ name, status, ms, detail })
  console.log(`${status.padEnd(11)} ${name.padEnd(18)} ${String(ms).padStart(5)} ms  ${detail}`)
}

const report = { node: process.version, platform: process.platform, arch: process.arch, payload: root, results }
if (jsonPath !== undefined) writeFileSync(jsonPath, `${JSON.stringify(report, undefined, 2)}\n`)
process.exitCode = results.some(result => result.status === 'failed') ? 1 : 0
