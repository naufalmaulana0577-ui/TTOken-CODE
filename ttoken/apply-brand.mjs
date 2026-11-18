#!/usr/bin/env node
/**
 * Terapkan identitas TTOken Code ke pohon sumber DeepSeek Harness.
 *
 * Skrip ini satu-satunya tempat yang tahu apa saja yang berbeda dari upstream.
 * Setelah merge dari upstream, jalankan ulang: aturan yang polanya hilang
 * akan gagal dengan keras, bukan diam-diam terlewat.
 *
 *   node ttoken/apply-brand.mjs            terapkan
 *   node ttoken/apply-brand.mjs --dry-run  tampilkan rencana tanpa menulis
 *   node ttoken/apply-brand.mjs --check    gagal bila pohon belum sepenuhnya bermerek
 *
 * Tanpa dependensi; cukup Node dan git.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const brand = JSON.parse(readFileSync(join(ROOT, 'ttoken', 'brand.json'), 'utf8'))
const upstream = brand.upstream

const flags = new Set(process.argv.slice(2))
for (const flag of flags) {
  if (!['--dry-run', '--check'].includes(flag)) {
    console.error(`apply-brand: opsi tidak dikenal: ${flag}`)
    process.exit(2)
  }
}
const DRY = flags.has('--dry-run')
const CHECK = flags.has('--check')

/** Dokumentasi upstream tidak ikut diganti: isinya menjelaskan upstream, bukan produk ini. */
const SKIPPED_SUFFIXES = ['.md', '.i18n.yaml']

/**
 * Daftar file teks terlacak git di bawah beberapa direktori.
 * @param {string[]} scopes Path relatif terhadap akar repo.
 * @returns {string[]} Path relatif file teks.
 */
function trackedTextFiles(scopes) {
  const output = execFileSync('git', ['ls-files', '-z', '--', ...scopes], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
  return output.toString('utf8').split('\0').filter(path => path !== ''
    && !path.startsWith('ttoken/')
    && !SKIPPED_SUFFIXES.some(suffix => path.endsWith(suffix)))
}

/**
 * Hitung kemunculan sebuah token.
 * @param {string} text Isi file.
 * @param {string} token Token literal.
 * @returns {number} Jumlah kemunculan.
 */
function count(text, token) {
  return text.split(token).length - 1
}

const failures = []
const report = []

/**
 * Ganti token literal di semua file teks dalam cakupan.
 *
 * Sebuah aturan sah bila token upstream masih ada (belum diterapkan) atau
 * token pengganti sudah ada (sudah diterapkan). Bila keduanya nol, upstream
 * sudah berubah dan aturannya harus diperbarui.
 * @param {{ name: string, scopes: string[], pairs: [string, string][] }} rule Aturan penggantian.
 * @returns {void}
 */
function replaceTokens(rule) {
  let pending = 0
  let applied = 0
  let touched = 0
  for (const path of trackedTextFiles(rule.scopes)) {
    const absolute = join(ROOT, path)
    const buffer = readFileSync(absolute)
    if (buffer.includes(0)) continue
    const original = buffer.toString('utf8')
    let next = original
    for (const [from, to] of rule.pairs) {
      pending += count(next, from)
      next = next.split(from).join(to)
    }
    for (const [, to] of rule.pairs) applied += count(next, to)
    if (next === original) continue
    touched += 1
    if (!DRY && !CHECK) writeFileSync(absolute, next)
  }
  if (pending === 0 && applied === 0) {
    failures.push(`${rule.name}: tidak ada token upstream maupun token pengganti; upstream berubah, perbarui aturannya`)
    return
  }
  if (CHECK && pending > 0) {
    failures.push(`${rule.name}: ${pending} token upstream tersisa di ${touched} file`)
    return
  }
  report.push(pending === 0
    ? `${rule.name}: sudah diterapkan`
    : `${rule.name}: ${pending} penggantian di ${touched} file${DRY ? ' (rencana)' : ''}`)
}

/**
 * Sunting satu file dengan pasangan literal yang masing-masing harus cocok tepat sekali.
 * @param {{ name: string, path: string, pairs: [string, string][] }} rule Aturan penyuntingan.
 * @returns {void}
 */
function editFile(rule) {
  const absolute = join(ROOT, rule.path)
  let text = readFileSync(absolute, 'utf8')
  let changed = 0
  for (const [from, to] of rule.pairs) {
    if (text.includes(to)) continue
    if (count(text, from) !== 1) {
      failures.push(`${rule.name}: pola berikut harus muncul tepat sekali di ${rule.path}: ${JSON.stringify(from)}`)
      return
    }
    if (CHECK) {
      failures.push(`${rule.name}: ${rule.path} belum disunting`)
      return
    }
    text = text.replace(from, () => to)
    changed += 1
  }
  if (changed > 0 && !DRY) writeFileSync(absolute, text)
  report.push(changed === 0 ? `${rule.name}: sudah diterapkan` : `${rule.name}: ${changed} suntingan${DRY ? ' (rencana)' : ''}`)
}

/**
 * Tulis sebuah file hasil bila isinya berbeda.
 * @param {string} name Nama aturan.
 * @param {string} path Path relatif tujuan.
 * @param {string} content Isi yang diharapkan.
 * @returns {void}
 */
function writeGenerated(name, path, content) {
  const absolute = join(ROOT, path)
  const current = existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined
  if (current === content) {
    report.push(`${name}: sudah diterapkan`)
    return
  }
  if (CHECK) {
    failures.push(`${name}: ${path} tidak sama dengan sumbernya`)
    return
  }
  if (!DRY) writeFileSync(absolute, content)
  report.push(`${name}: ${path} ditulis${DRY ? ' (rencana)' : ''}`)
}

/**
 * Salin aset biner bila berbeda.
 * @param {string} name Nama aturan.
 * @param {[string, string][]} pairs Pasangan sumber dan tujuan, relatif terhadap akar repo.
 * @returns {void}
 */
function copyAssets(name, pairs) {
  let copied = 0
  for (const [from, to] of pairs) {
    const source = join(ROOT, from)
    const target = join(ROOT, to)
    if (!existsSync(source)) {
      failures.push(`${name}: sumber tidak ada: ${from}`)
      return
    }
    if (existsSync(target) && readFileSync(source).equals(readFileSync(target))) continue
    if (CHECK) {
      failures.push(`${name}: ${to} belum diganti`)
      return
    }
    if (!DRY) copyFileSync(source, target)
    copied += 1
  }
  report.push(copied === 0 ? `${name}: sudah diterapkan` : `${name}: ${copied} file disalin${DRY ? ' (rencana)' : ''}`)
}

// 1. Nama produk yang terlihat user: menu, dialog, installer, nama .app dan .exe.
replaceTokens({
  name: 'nama-produk',
  scopes: ['apps/desktop'],
  pairs: [[upstream.productName, brand.productName]],
})

// 2. Nama file installer dan direktori cache updater. Skrip unggah dan publisher
//    mencari artefak lewat awalan ini, jadi semuanya diganti bersama.
replaceTokens({
  name: 'awalan-artefak',
  scopes: ['apps/desktop', 'apps/desktop-publisher'],
  pairs: [[`${upstream.artifactPrefix}-`, `${brand.artifactPrefix}-`]],
})

// 3. Identitas aplikasi. Harus berbeda dari build resmi supaya macOS dan
//    Windows tidak menganggap keduanya aplikasi yang sama.
replaceTokens({
  name: 'app-id',
  scopes: ['apps/desktop'],
  pairs: upstream.appIds.map(id => [id, brand.appId]),
})

// 4. Skema URL yang didaftarkan ke sistem operasi. Skema internal `dsh-app`
//    tidak didaftarkan ke OS dan dibiarkan.
replaceTokens({
  name: 'skema-protokol',
  scopes: ['apps/desktop'],
  pairs: [
    [`schemes: ['${upstream.protocolScheme}']`, `schemes: ['${brand.protocolScheme}']`],
    [`schemes: readonly ['${upstream.protocolScheme}']`, `schemes: readonly ['${brand.protocolScheme}']`],
    [`CFBundleURLSchemes: ['${upstream.protocolScheme}']`, `CFBundleURLSchemes: ['${brand.protocolScheme}']`],
    [`setAsDefaultProtocolClient('${upstream.protocolScheme}')`, `setAsDefaultProtocolClient('${brand.protocolScheme}')`],
    [`'${upstream.protocolScheme}://`, `'${brand.protocolScheme}://`],
  ],
})

// 5. Direktori data. Tanpa ini TTOken Code berbagi sesi, kredensial, dan kunci
//    profil desktop dengan instalasi resmi di ~/.dsh.
editFile({
  name: 'direktori-data',
  path: 'packages/util/home-paths/src/index.ts',
  pairs: [[
    `export const DSH_HOME_DIR_NAME = '${upstream.homeDirName}'`,
    `export const DSH_HOME_DIR_NAME = '${brand.homeDirName}'`,
  ]],
})

// 6. Lapisan distribusi: rute Gateway, model bawaan, telemetri upstream mati.
//    Ditanam sebagai string supaya alur packaging upstream tidak perlu diubah.
const layer = readFileSync(join(ROOT, 'ttoken', 'layer', 'cordis.patch.yml'), 'utf8')
writeGenerated('lapisan-distribusi', 'apps/desktop-host/src/ttoken-layer.ts', `/**
 * TTOken Code distribution layer, embedded so Desktop packaging ships it without an extra resource.
 * Generated by ttoken/apply-brand.mjs from ttoken/layer/cordis.patch.yml; edit that file instead.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LAYER = ${JSON.stringify(layer)}

/**
 * Write the distribution layer into the Desktop profile directory.
 * @param profileDirectory - Desktop profile directory that Electron passes to the Host.
 * @returns Absolute overlay path for the profile launcher's patch list.
 */
export function materializeTtokenLayer(profileDirectory: string): string {
  mkdirSync(profileDirectory, { recursive: true })
  const path = join(profileDirectory, 'ttoken.cordis.patch.yml')
  writeFileSync(path, LAYER, 'utf8')
  return path
}
`)
editFile({
  name: 'pasang-lapisan',
  path: 'apps/desktop-host/src/index.ts',
  pairs: [
    [
      `import { localDragResource } from './file-drag.ts'\n`,
      `import { localDragResource } from './file-drag.ts'\nimport { materializeTtokenLayer } from './ttoken-layer.ts'\n`,
    ],
    [`    patchFiles: [],\n`, `    patchFiles: [materializeTtokenLayer(projectDir)],\n`],
  ],
})

// 7. Kebijakan update wajib hanya untuk build bertanda tangan. Upstream sudah
//    melewatinya di macOS tanpa tanda tangan; di sini Windows disamakan, supaya
//    installer uji bisa dibangun sebelum layanan kebijakan milik TTOken ada.
//    Tanpa metadata kebijakan, aplikasi tidak menghubungi layanan itu sama sekali.
editFile({
  name: 'kebijakan-update-opsional (builder)',
  path: 'apps/desktop/scripts/electron-builder-config.mjs',
  pairs: [[
    `const policy = packagesMacOS && unsigned ? undefined : resolveDesktopPolicyEnvironment(env)`,
    `const policy = unsigned ? undefined : resolveDesktopPolicyEnvironment(env)`,
  ]],
})
editFile({
  name: 'kebijakan-update-opsional (validasi)',
  path: 'apps/desktop/scripts/desktop-package-environment.mjs',
  pairs: [[
    `if (target.platform !== 'darwin' || !options.unsigned) resolveDesktopPolicyEnvironment(environment)`,
    `if (!options.unsigned) resolveDesktopPolicyEnvironment(environment)`,
  ]],
})

// 8. Ikon aplikasi dan tray.
copyAssets('ikon', [
  ['ttoken/icons/icon.svg', 'apps/desktop/resources/icon.svg'],
  ['ttoken/icons/icon.png', 'apps/desktop/resources/icon.png'],
  ['ttoken/icons/icon-macos.svg', 'apps/desktop/resources/icon-macos.svg'],
  ['ttoken/icons/icon-macos.png', 'apps/desktop/resources/icon-macos.png'],
  ['ttoken/icons/icon-windows.svg', 'apps/desktop/resources/icon-windows.svg'],
  ['ttoken/icons/icon-windows.png', 'apps/desktop/resources/icon-windows.png'],
  ['ttoken/icons/tray-windows.ico', 'apps/desktop/resources/tray-windows.ico'],
])

for (const line of report) console.log(line)
if (failures.length > 0) {
  for (const line of failures) console.error(`GAGAL  ${line}`)
  process.exit(1)
}
