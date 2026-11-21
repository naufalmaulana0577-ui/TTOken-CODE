/**
 * Turn the `resources` directory of a packaged Electron build into a payload that plain Node can run.
 *
 * Usage: <bundled node> extract-payload.mjs <resources directory> <output directory>
 *
 * electron-builder packs the dsh project into `app.asar` and unpacks only native code into `app.asar.unpacked`.
 * Electron, also in Node mode, reads the archive transparently; plain Node cannot, and the Tauri shell runs the Host
 * on the bundled Node. This script writes the archive's `dsh` tree as files into `<output>/dsh`, copies unpacked
 * entries from `app.asar.unpacked`, and links `<output>/runtime` to the build's `runtime` directory (a junction on
 * Windows), so `<output>` has the payload layout the shell expects. Links inside the archive are written as copies of
 * their targets. `<output>/payload.json` names the archive the tree came from; a later run against the same archive
 * leaves the output as it is. The script only replaces an output directory it wrote itself.
 */

import { createHash } from 'node:crypto'
import {
  chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const PROJECT = 'dsh'
const MARKER = '.ttoken-extract-payload'
const CHUNK_BYTES = 1024 * 1024
const MAX_LINK_DEPTH = 32
// Errors Windows reports while antivirus or an indexer briefly holds a file open; they are retried.
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])
const RETRY_MS = 30_000
const HOST_ENTRY = [PROJECT, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js']

const [resourcesArgument, outputArgument, ...extra] = process.argv.slice(2)
if (resourcesArgument === undefined || outputArgument === undefined || extra.length > 0) {
  console.error('usage: node extract-payload.mjs <resources directory> <output directory>')
  process.exit(2)
}
const resources = resolve(resourcesArgument)
const output = resolve(outputArgument)
const archive = join(resources, 'app.asar')
const unpackedRoot = `${archive}.unpacked`
const runtime = join(resources, 'runtime')

/** True when `child` is `parent` or lies inside it. */
function within(parent, child) {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

if (!existsSync(archive) || !existsSync(runtime)) {
  throw new Error(`${resources} has no app.asar and runtime; pass the resources directory of a packaged Electron build`)
}
if (within(resources, output) || within(output, resources)) {
  throw new Error(`the output directory must lie outside ${resources}`)
}

/**
 * Read the archive header: two Chromium pickles, `[payload size][header size]` then `[payload size][length][JSON]`.
 * @param {string} path Archive file.
 * @returns {{ tree: object, dataOffset: number, digest: string }} Entry tree, where file contents start, header digest.
 */
function readHeader(path) {
  const fd = openSync(path, 'r')
  try {
    const prefix = Buffer.alloc(16)
    if (readSync(fd, prefix, 0, 16, 0) !== 16) throw new Error(`${path}: too short for an asar archive`)
    const headerSize = prefix.readUInt32LE(4)
    const length = prefix.readUInt32LE(12)
    if (headerSize < 8 || length > headerSize - 8) throw new Error(`${path}: malformed asar header`)
    const json = Buffer.alloc(length)
    if (readSync(fd, json, 0, length, 16) !== length) throw new Error(`${path}: truncated asar header`)
    return {
      tree: JSON.parse(json.toString('utf8')),
      dataOffset: 8 + headerSize,
      digest: createHash('sha256').update(json).digest('hex'),
    }
  } finally {
    closeSync(fd)
  }
}

/** Names of an archive-relative path; a path that climbs out of the archive is rejected. */
function namesOf(path) {
  const names = path.split(/[\\/]+/u).filter(name => name !== '' && name !== '.')
  if (names.includes('..')) throw new Error(`asar link ${JSON.stringify(path)} leaves the archive`)
  return names
}

/**
 * Follow links until the entry is a file or directory.
 * @param {object} root Archive tree.
 * @param {{ node: object, path: string }} entry Entry and its archive path.
 * @param {number} depth Links followed so far on this branch.
 * @returns {{ node: object, path: string }} The entry the links lead to, with its own archive path.
 */
function resolveLinks(root, entry, depth) {
  let current = entry
  let hops = depth
  while (current.node.link !== undefined) {
    hops += 1
    if (hops > MAX_LINK_DEPTH) throw new Error(`asar entry ${entry.path}: too many links`)
    current = lookup(root, current.node.link, hops)
  }
  return current
}

/** Find an entry by archive path, following links in its parent directories. */
function lookup(root, path, depth) {
  let current = { node: root, path: '' }
  for (const name of namesOf(path)) {
    current = resolveLinks(root, current, depth)
    const { files } = current.node
    if (files === undefined || !Object.hasOwn(files, name)) throw new Error(`asar entry ${path} is missing`)
    current = { node: files[name], path: current.path === '' ? name : `${current.path}/${name}` }
  }
  return current
}

/** Copy one packed file out of the archive, checking its SHA-256 when the header records one. */
function copyPacked(context, node, path, destination) {
  if (typeof node.offset !== 'string') throw new Error(`asar entry ${path} has no offset`)
  const start = context.dataOffset + Number(node.offset)
  const integrity = node.integrity
  const hash = integrity?.algorithm === 'SHA256' && typeof integrity.hash === 'string' ? createHash('sha256') : undefined
  const out = openSync(destination, 'w')
  try {
    let done = 0
    while (done < node.size) {
      const read = readSync(context.fd, context.buffer, 0, Math.min(context.buffer.length, node.size - done), start + done)
      if (read === 0) throw new Error(`asar entry ${path} runs past the end of the archive`)
      for (let written = 0; written < read;) written += writeSync(out, context.buffer, written, read - written)
      hash?.update(context.buffer.subarray(0, read))
      done += read
    }
  } finally {
    closeSync(out)
  }
  if (hash !== undefined && hash.digest('hex') !== integrity.hash) {
    throw new Error(`asar entry ${path} does not match its integrity hash`)
  }
  if (node.executable === true && process.platform !== 'win32') chmodSync(destination, 0o755)
}

/** Write an entry and everything under it to `destination`. */
function extract(context, entry, destination, depth) {
  let current = entry
  let level = depth
  if (current.node.link !== undefined) {
    // A link to a parent directory would repeat forever; every followed link counts toward MAX_LINK_DEPTH.
    current = resolveLinks(context.root, current, depth)
    level = depth + 1
    context.links += 1
  }
  const { node, path } = current
  if (node.files !== undefined) {
    mkdirSync(destination, { recursive: true })
    for (const name of Object.keys(node.files)) {
      if (name === '' || name === '.' || name === '..' || /[\\/]/u.test(name)) {
        throw new Error(`asar entry ${path} holds an unsafe name ${JSON.stringify(name)}`)
      }
      extract(context, { node: node.files[name], path: `${path}/${name}` }, join(destination, name), level)
    }
    return
  }
  if (!Number.isSafeInteger(node.size) || node.size < 0) throw new Error(`asar entry ${path} has no size`)
  const unpacked = join(unpackedRoot, ...path.split('/'))
  if (node.unpacked === true || (node.offset === undefined && existsSync(unpacked))) copyFileSync(unpacked, destination)
  else copyPacked(context, node, path, destination)
  context.files += 1
  context.bytes += node.size
}

/** Throw unless `path` is absent, empty, or a directory this script wrote. */
function assertReplaceable(path) {
  if (existsSync(path) && !existsSync(join(path, MARKER)) && readdirSync(path).length > 0) {
    throw new Error(`${path} exists and was not written by extract-payload.mjs`)
  }
}

/** Block for `ms` milliseconds. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Run one file system change, retrying for up to 30 seconds while Windows reports the path in use. The script does
 * its own retries: on Windows, fs.rmSync waits only a few milliseconds in total between its retries (Node 24, `RmSync`
 * in src/node_file.cc sleeps `i * retryDelay / 1000` milliseconds).
 */
function retrying(what, change) {
  const deadline = performance.now() + RETRY_MS
  for (let wait = 50, told = false; ; wait = Math.min(wait * 2, 1000)) {
    try {
      return change()
    } catch (error) {
      if (!BUSY_CODES.has(error.code) || performance.now() + wait > deadline) throw error
      if (!told) {
        console.log(`${what}: ${error.code}, retrying for up to ${RETRY_MS / 1000} s`)
        told = true
      }
      sleep(wait)
    }
  }
}

/** Remove a file, a link, or a directory tree. A link is removed itself; its target (the runtime) is not touched. */
function removeTree(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) removeTree(join(path, name))
    retrying(`remove ${path}`, () => { rmdirSync(path) })
  } else {
    retrying(`remove ${path}`, () => { unlinkSync(path) })
  }
}

/**
 * Remove a directory this script wrote. `payload.json`, written last, goes first and the marker goes last, so a
 * removal cut short leaves a directory the next run neither takes for a complete payload nor refuses as foreign.
 */
function removeOwnDirectory(path) {
  if (!existsSync(path)) return
  assertReplaceable(path)
  const link = join(path, 'runtime')
  const stat = lstatSync(link, { throwIfNoEntry: false })
  if (stat !== undefined && !stat.isSymbolicLink()) throw new Error(`${link} is not a link; remove ${path} by hand`)
  removeTree(join(path, 'payload.json'))
  for (const name of readdirSync(path)) {
    if (name !== MARKER) removeTree(join(path, name))
  }
  removeTree(path)
}

/** Rename a directory, retrying for up to 30 seconds while Windows reports it in use. */
function renameWithRetry(from, to) {
  retrying(`rename ${from} to ${to}`, () => { renameSync(from, to) })
}

const archiveStat = statSync(archive)
const header = readHeader(archive)
const source = { archive, size: archiveStat.size, mtimeMs: archiveStat.mtimeMs, header: header.digest, runtime }
const record = join(output, 'payload.json')

/** True when the output came from this very archive and still has the Host entry and the runtime link. */
function upToDate() {
  if (!existsSync(record) || !existsSync(join(output, ...HOST_ENTRY))) return false
  if (!existsSync(join(output, 'runtime', 'primary-runtime'))) return false
  try {
    const previous = JSON.parse(readFileSync(record, 'utf8')).source
    return Object.entries(source).every(([key, value]) => previous?.[key] === value)
  } catch {
    return false
  }
}

const staging = `${output}.partial`
const previous = `${output}.previous`
// A run stopped between its two renames leaves the earlier payload only at `.previous`; put it back first, so it is
// kept until a new one is in place, and is reused when it is still current.
if (!existsSync(output) && existsSync(join(previous, MARKER)) && existsSync(join(previous, 'payload.json'))) {
  renameWithRetry(previous, output)
  console.log(`restored the earlier payload from ${previous}`)
}

/** Remove what an earlier run left next to the output; a directory still in use is left for the next run. */
function removeLeftovers() {
  for (const path of [staging, previous]) {
    try {
      removeOwnDirectory(path)
    } catch (error) {
      console.warn(`could not remove ${path}: ${error.message}`)
    }
  }
}

if (upToDate()) {
  console.log(`${output} is up to date with ${archive}`)
  removeLeftovers()
} else {
  const started = performance.now()
  // Refuse a foreign output directory before any work, not after the extraction.
  assertReplaceable(output)
  removeOwnDirectory(staging)
  removeOwnDirectory(previous)
  mkdirSync(staging, { recursive: true })
  writeFileSync(join(staging, MARKER), '')
  const context = {
    root: header.tree, dataOffset: header.dataOffset, fd: openSync(archive, 'r'), buffer: Buffer.allocUnsafe(CHUNK_BYTES),
    files: 0, bytes: 0, links: 0,
  }
  try {
    try {
      extract(context, lookup(header.tree, PROJECT, 0), join(staging, PROJECT), 0)
    } finally {
      closeSync(context.fd)
    }
    if (!existsSync(join(staging, ...HOST_ENTRY))) throw new Error(`${archive}: the ${PROJECT} project has no Desktop Host entry`)
    symlinkSync(runtime, join(staging, 'runtime'), 'junction')
    const summary = { source, files: context.files, bytes: context.bytes, links: context.links }
    writeFileSync(join(staging, 'payload.json'), `${JSON.stringify(summary, null, 2)}\n`)
    // The earlier payload stays usable until the new one is in place.
    if (existsSync(output)) renameWithRetry(output, previous)
    try {
      renameWithRetry(staging, output)
    } catch (error) {
      if (existsSync(previous) && !existsSync(output)) renameWithRetry(previous, output)
      throw error
    }
  } catch (error) {
    removeOwnDirectory(staging)
    throw error
  }
  // The new payload is in place; an earlier one that cannot be removed now is removed by the next run.
  removeLeftovers()
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  const megabytes = (context.bytes / 1024 / 1024).toFixed(1)
  console.log(`extracted ${context.files} files (${megabytes} MB, ${context.links} links) in ${seconds} s into ${join(output, PROJECT)}`)
}
