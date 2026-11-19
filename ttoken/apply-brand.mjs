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
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const brand = JSON.parse(readFileSync(join(ROOT, 'ttoken', 'brand.json'), 'utf8'))
const upstream = brand.upstream
/** Login akun TTOken menyala hanya setelah rute `/api/v1/code/desktop` di server TTOken ter-deploy. */
const ACCOUNT_LOGIN = brand.accountLogin === true
/** Pencarian web menyala hanya setelah `POST /v1/tools/search` di server TTOken ter-deploy dengan key pencarian (DeepSeek Flash native, atau Brave). */
const WEB_SEARCH = brand.webSearch === true

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
 * Frasa di `keep` tidak disentuh dan tidak dihitung, misalnya atribusi yang memang harus memuat nama upstream.
 * @param {{ name: string, scopes: string[], pairs: [string, string][], keep?: string[] }} rule Aturan penggantian.
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
    const kept = rule.keep ?? []
    kept.forEach((phrase, index) => { next = next.split(phrase).join(`\u0000KEEP${index}\u0000`) })
    for (const [from, to] of rule.pairs) {
      pending += count(next, from)
      next = next.split(from).join(to)
    }
    for (const [, to] of rule.pairs) applied += count(next, to)
    kept.forEach((phrase, index) => { next = next.split(`\u0000KEEP${index}\u0000`).join(phrase) })
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
 * Ganti satu wilayah file, dari penanda awal sampai tepat sebelum penanda akhir, dengan isi baru.
 *
 * Wilayah dianggap sudah diterapkan bila isi baru sudah ada di file. Kedua penanda
 * harus muncul tepat sekali dan berurutan; isi baru tidak boleh memuat penanda awal.
 * Penanda akhir kosong berarti wilayah berlanjut sampai akhir file.
 * @param {{ name: string, path: string, start: string, end: string, content: string }} rule Aturan penggantian.
 * @returns {void}
 */
function replaceRegion(rule) {
  const absolute = join(ROOT, rule.path)
  const text = readFileSync(absolute, 'utf8')
  if (text.includes(rule.content)) {
    report.push(`${rule.name}: sudah diterapkan`)
    return
  }
  const from = text.indexOf(rule.start)
  const to = rule.end === '' ? text.length : text.indexOf(rule.end)
  if (count(text, rule.start) !== 1 || (rule.end !== '' && count(text, rule.end) !== 1) || to < from) {
    failures.push(`${rule.name}: penanda wilayah tidak cocok di ${rule.path}; upstream berubah, perbarui aturannya`)
    return
  }
  if (CHECK) {
    failures.push(`${rule.name}: ${rule.path} belum disunting`)
    return
  }
  if (!DRY) writeFileSync(absolute, text.slice(0, from) + rule.content + text.slice(to))
  report.push(`${rule.name}: wilayah diganti${DRY ? ' (rencana)' : ''}`)
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
  if (!DRY) {
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
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

/**
 * Ganti nilai literal string satu baris di semua deklarasi atau kunci yang cocok.
 *
 * `pattern` harus punya dua grup: awalan sampai sebelum literal, lalu literal lama beserta tanda kutipnya.
 * @param {{ name: string, paths: string[], pattern: RegExp, value: string, expected: number }} rule Aturan penggantian.
 * @returns {void}
 */
function setQuotedValues(rule) {
  let matches = 0
  let pending = 0
  for (const path of rule.paths) {
    const absolute = join(ROOT, path)
    const original = readFileSync(absolute, 'utf8')
    const literal = `'${rule.value}'`
    const next = original.replace(rule.pattern, (whole, head, current) => {
      matches += 1
      if (current === literal) return whole
      pending += 1
      return `${head}${literal}`
    })
    if (next !== original && !DRY && !CHECK) writeFileSync(absolute, next)
  }
  if (matches !== rule.expected) {
    failures.push(`${rule.name}: menemukan ${matches} nilai, seharusnya ${rule.expected}; upstream berubah, perbarui aturannya`)
    return
  }
  if (CHECK && pending > 0) {
    failures.push(`${rule.name}: ${pending} nilai upstream tersisa`)
    return
  }
  report.push(pending === 0 ? `${rule.name}: sudah diterapkan` : `${rule.name}: ${pending} nilai diganti${DRY ? ' (rencana)' : ''}`)
}

/**
 * Bangun perintah path SVG untuk persegi bersudut bulat, searah jarum jam.
 * @param {number} x Tepi kiri.
 * @param {number} y Tepi atas.
 * @param {number} w Lebar.
 * @param {number} h Tinggi.
 * @param {number} r Jari-jari sudut.
 * @returns {string} Data path tertutup.
 */
function roundedRect(x, y, w, h, r) {
  return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}`
    + `H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`
}

/** Mark TTOken Code pada kanvas 56x48: badan berwarna kunyit dan garis kursor. */
const MARK_BODY = roundedRect(0, 0, 56, 16, 8) + roundedRect(6, 4, 18, 44, 9) + roundedRect(32, 4, 18, 26, 9)
const MARK_BAR = roundedRect(32, 37, 18, 8, 4)
const KUNYIT = '#FFB21A'

/** Berkas kamus bahasa: `locale.ts`, `locales.ts`, dan isi folder `locale/` atau `locales/`. */
const LOCALE_FILE = /(^|\/)(locales?\.ts|locales?\/[^/]+\.(ts|json))$/
/** Literal string satu baris dalam kutip tunggal, ganda, atau backtick. */
const STRING_LITERAL = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g

/**
 * Ganti nama upstream di dalam literal string semua kamus bahasa.
 *
 * Kode di luar literal tidak disentuh. Literal yang memuat frasa `keep` dilewati utuh.
 * Dengan `files`, hanya berkas itu yang diproses; berkas Markdown di dalamnya diproses seluruh teksnya.
 * `edits` menambah pola untuk aturan itu saja, misalnya nama layanan upstream di teks akun.
 * @param {{ name: string, scopes?: string[], files?: string[], keep: string[], edits?: [RegExp, string][] }} rule Aturan penggantian.
 * @returns {void}
 */
function rebrandLocaleStrings(rule) {
  const product = brand.productName
  const edits = [
    // Contoh perintah huruf kecil di dalam kurung, dalam bahasa apa pun.
    [/\s*[(（][^()（）]*\bdsh\b[^()（）]*[)）]/g, ''],
    [new RegExp(`\\b${upstream.productName}\\b`, 'g'), product],
    [/\bDSH\b/g, product],
    [/\bHarness\b/g, product],
    ...rule.edits ?? [],
  ]
  let pending = 0
  let touched = 0
  let files = 0
  const paths = rule.files ?? trackedTextFiles(rule.scopes ?? []).filter(path => LOCALE_FILE.test(path)
    && !/(^|\/)(tests?|fixtures)\//.test(path) && !/\.(spec|test)\./.test(path))
  for (const path of paths) {
    const absolute = join(ROOT, path)
    if (!existsSync(absolute)) {
      failures.push(`${rule.name}: berkas tidak ada: ${path}; upstream berubah, perbarui aturannya`)
      continue
    }
    files += 1
    const original = readFileSync(absolute, 'utf8')
    let changes = 0
    const rewrite = body => {
      if (rule.keep.some(phrase => body.includes(phrase))) return body
      let value = body
      for (const [pattern, replacement] of edits) value = value.replace(pattern, () => { changes += 1; return replacement })
      return value
    }
    const next = path.endsWith('.md')
      ? rewrite(original)
      : original.replace(STRING_LITERAL, (literal, quote, body) => {
        const value = rewrite(body)
        return value === body ? literal : `${quote}${value}${quote}`
      })
    if (changes === 0) continue
    pending += changes
    touched += 1
    if (!DRY && !CHECK) writeFileSync(absolute, next)
  }
  if (files === 0) {
    failures.push(`${rule.name}: tidak ada berkas kamus bahasa; upstream berubah, perbarui aturannya`)
    return
  }
  if (CHECK && pending > 0) {
    failures.push(`${rule.name}: ${pending} penyebutan upstream tersisa di ${touched} berkas`)
    return
  }
  report.push(pending === 0 ? `${rule.name}: sudah diterapkan (${files} berkas)` : `${rule.name}: ${pending} penggantian di ${touched} berkas${DRY ? ' (rencana)' : ''}`)
}

/**
 * Tulis literal string sesuai urutan kemunculan kunci, satu nilai per blok bahasa.
 * @param {{ name: string, path: string, key: string, values: string[] }} rule Kunci dan nilainya, urut seperti blok bahasa di berkas.
 * @returns {void}
 */
function setLocaleValues(rule) {
  const absolute = join(ROOT, rule.path)
  const original = readFileSync(absolute, 'utf8')
  const pattern = new RegExp(`(?<![\\w$])((?:'${rule.key}'|${rule.key})\\s*:\\s*)('(?:\\\\.|[^'\\\\\\n])*'|"(?:\\\\.|[^"\\\\\\n])*")`, 'g')
  let index = 0
  let pending = 0
  const next = original.replace(pattern, (whole, head, current) => {
    const value = rule.values[index++]
    if (value === undefined) return whole
    const literal = value.includes("'") ? JSON.stringify(value) : `'${value}'`
    if (current === literal) return whole
    pending += 1
    return `${head}${literal}`
  })
  if (index !== rule.values.length) {
    failures.push(`${rule.name}: menemukan ${index} nilai ${rule.key}, seharusnya ${rule.values.length}; upstream berubah, perbarui aturannya`)
    return
  }
  if (CHECK && pending > 0) {
    failures.push(`${rule.name}: ${pending} nilai upstream tersisa`)
    return
  }
  if (pending > 0 && !DRY && !CHECK) writeFileSync(absolute, next)
  report.push(pending === 0 ? `${rule.name}: sudah diterapkan` : `${rule.name}: ${pending} nilai diganti${DRY ? ' (rencana)' : ''}`)
}

/** Paket yang tetap mati: hanya berguna dengan layanan DeepSeek, mengirim data ke sana, atau digantikan rute TTOken Gateway. */
const ALWAYS_HIDDEN = [
  'dsh-llm-deepseek-api-key',
  'dsh-deepseek-llm-api-extensions',
  'dsh-llm-deepseek-account',
  'dsh-plugin-package-inventory-deepseek',
  'dsh-session-log-deepseek',
  'dsh-web-search-deepseek',
  'dsh-deepseek-chat-import',
  'dsh-experimental-liveshare',
  'dsh-skill-badge',
  'dsh-experimental-badge-skill-bundle',
  'dsh-client-ui-settings-session-log',
  'dsh-client-ui-settings-web-search',
]
/** Menyala tetapi tidak ditampilkan: tanpa layanan akun, layar sambutan gagal membaca status dan aplikasi gagal saat mulai. */
const REQUIRED_PACKAGES = ['dsh-deepseek-account']
/** Layanan internal pencarian web; menyala bersama pencarian web, tidak perlu dilihat user. */
const INTERNAL_PACKAGES = ['dsh-deepseek-auth']
/** Pencarian web lewat TTOken Gateway; tampil begitu `webSearch` menyala. */
const WEB_PACKAGES = ['dsh-web-deepseek-api']
/** Antarmuka login akun TTOken; tampil begitu `accountLogin` menyala. */
const ACCOUNT_PACKAGES = ['dsh-client-ui-settings-account', 'dsh-client-ui-account-notifications']
/** Mati sampai diarahkan ke server TTOken: analitik. */
const PENDING_PACKAGES = [
  'dsh-client-product-analytics',
  'dsh-host-product-telemetry-otel',
  'dsh-session-telemetry-otel',
]
/**
 * Paket yang tidak boleh tampil di halaman Plugins atau rekomendasi plugin: yang dimatikan
 * lapisan distribusi, supaya user tidak menyalakannya lagi, dan yang wajib menyala, supaya
 * user tidak mematikannya.
 */
const HIDDEN_PACKAGES = [
  ...ALWAYS_HIDDEN, ...REQUIRED_PACKAGES, ...INTERNAL_PACKAGES,
  ...ACCOUNT_LOGIN ? [] : ACCOUNT_PACKAGES, ...WEB_SEARCH ? [] : WEB_PACKAGES, ...PENDING_PACKAGES,
]
  .map(name => `@deepseek-ai/${name}`)
/** Modul hasil yang memuat {@link HIDDEN_PACKAGES} untuk halaman Plugins dan rekomendasi plugin. */
const HIDDEN_MODULE = `/**
 * TTOken Code: packages the distribution switches off, which the Plugins page and plugin recommendations do not list.
 * Generated by ttoken/apply-brand.mjs; edit HIDDEN_PACKAGES there instead.
 */

/** Hidden package names. */
export const TTOKEN_HIDDEN_PACKAGES: ReadonlySet<string> = new Set(${JSON.stringify(HIDDEN_PACKAGES, null, 2).replaceAll('"', "'")})
`

/** Satu-satunya tempat nama upstream boleh terlihat user: baris atribusi di layar sambutan. */
const ATTRIBUTION = 'Powered by DeepSeek Harness'

// 1. Nama produk yang terlihat user: menu, dialog, installer, nama .app dan .exe.
replaceTokens({
  name: 'nama-produk',
  scopes: ['apps/desktop'],
  pairs: [[upstream.productName, brand.productName]],
  keep: [ATTRIBUTION],
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
const baseLayer = readFileSync(join(ROOT, 'ttoken', 'layer', 'cordis.patch.yml'), 'utf8')
/**
 * Baris lapisan yang mengikuti saklar: apa adanya bila menyala, setiap baris dimatikan bila tidak.
 * @param {string} file Nama file di ttoken/layer.
 * @param {boolean} enabled Nilai saklar.
 * @returns {string} Isi YAML.
 */
function switchedLayer(file, enabled) {
  const text = readFileSync(join(ROOT, 'ttoken', 'layer', file), 'utf8')
  return enabled ? text : text.replace(/^- id: (.+)$/gm, '- id: $1\n  disabled: true')
}
const layer = [baseLayer, switchedLayer('account.patch.yml', ACCOUNT_LOGIN), switchedLayer('web.patch.yml', WEB_SEARCH)].join('\n')
const GATEWAY_KEY_REF = /\n {8}apiKeyEnv: ([A-Z_][A-Z0-9_]*)\n/.exec(baseLayer)?.[1]
if (GATEWAY_KEY_REF === undefined) failures.push('lapisan-distribusi: apiKeyEnv rute ttoken tidak ditemukan di ttoken/layer/cordis.patch.yml')
writeGenerated('lapisan-distribusi', 'apps/desktop-host/src/ttoken-layer.ts', `/**
 * TTOken Code distribution layer, embedded so Desktop packaging ships it without an extra resource.
 * Generated by ttoken/apply-brand.mjs from the files in ttoken/layer; edit those files instead.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LAYER = ${JSON.stringify(layer)}

/** Credential reference of the TTOken Gateway route's API key. */
export const TTOKEN_GATEWAY_KEY_REF = ${JSON.stringify(GATEWAY_KEY_REF ?? '')}

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
      `import { localDragResource } from './file-drag.ts'\nimport { TTOKEN_GATEWAY_KEY_REF, materializeTtokenLayer } from './ttoken-layer.ts'\n`,
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

// 9. Gambar merek installer, layar sambutan, dan favicon. Aset upstream memuat
//    logo resmi DeepSeek Harness, yang tidak boleh dipakai produk turunan.
//    Sumbernya dibangun oleh ttoken/installer/generate-brand-assets.py.
copyAssets('gambar-installer', [
  ['ttoken/installer/brand.png', 'apps/desktop/installer/assets/brand.png'],
  ['ttoken/installer/brand-2x.png', 'apps/desktop/installer/assets/brand-2x.png'],
  ['ttoken/installer/brand-dark.png', 'apps/desktop/installer/assets/brand-dark.png'],
  ['ttoken/installer/brand-dark-2x.png', 'apps/desktop/installer/assets/brand-dark-2x.png'],
  ['ttoken/installer/uninstaller-sidebar.png', 'apps/desktop/installer/assets/uninstaller-sidebar.png'],
])
copyAssets('merek-sambutan', [
  ['ttoken/renderer/welcome-brand.svg', 'apps/desktop/renderer/assets/welcome-brand.svg'],
])
copyAssets('favicon', [
  ['ttoken/web/favicon.svg', 'apps/web/public/favicon.svg'],
  ['ttoken/web/favicon-dark.svg', 'apps/web/public/favicon-dark.svg'],
])

// 10. Nama penerbit di metadata .exe, serta kunci registry dan nama mutex perintah PATH.
editFile({
  name: 'penerbit',
  path: 'apps/desktop/package.json',
  pairs: [[`"name": "${upstream.publisher}"`, `"name": "${brand.publisher}"`]],
})
replaceTokens({
  name: 'kunci-registry',
  scopes: ['apps/desktop'],
  pairs: [[upstream.registryKey, brand.registryKey]],
})

// 11. Layar sambutan meminta API key TTOken Gateway, bukan key resmi DeepSeek.
//     Tombol login akun TTOken tampil hanya bila `accountLogin` menyala.
editFile({
  name: 'sambutan-kredensial',
  path: 'apps/desktop/src/welcome-backend.ts',
  pairs: [[
    `    const official: unknown = settings.namespaces.find((item: unknown) => record(item) && item.ns === 'llm-deepseek')
    if (official === undefined) return { settings: { namespaces: settings.namespaces }, ref: undefined }
    if (!record(official) || !record(official.value) || typeof official.value.apiKeyEnv !== 'string') {
      throw new Error('desktop welcome: missing official DeepSeek credential reference')
    }
    return { settings: { namespaces: settings.namespaces }, ref: official.value.apiKeyEnv }
`,
    `    const gateway: unknown = settings.namespaces.find((item: unknown) => record(item) && item.ns === 'llm-pi-ai')
    const route: unknown = record(gateway) && record(gateway.value) && record(gateway.value.providers) ? gateway.value.providers.ttoken : undefined
    if (route === undefined) return { settings: { namespaces: settings.namespaces }, ref: undefined }
    if (!record(route) || typeof route.apiKeyEnv !== 'string') {
      throw new Error('desktop welcome: missing TTOken Gateway credential reference')
    }
    return { settings: { namespaces: settings.namespaces }, ref: route.apiKeyEnv }
`,
  ]],
})
writeGenerated('sambutan-saklar', 'apps/desktop/src/client/ttoken-flags.ts', `/** TTOken Code distribution switches, generated by ttoken/apply-brand.mjs from ttoken/brand.json. */

/** Whether the welcome screen offers TTOken account sign-in. */
export const TTOKEN_ACCOUNT_LOGIN: boolean = ${ACCOUNT_LOGIN}
`)
editFile({
  name: 'sambutan-tombol',
  path: 'apps/desktop/src/client/WelcomePage.tsx',
  pairs: [
    [`import type { WelcomeApi } from '../welcome-api.ts'\n`, `import type { WelcomeApi } from '../welcome-api.ts'\nimport { TTOKEN_ACCOUNT_LOGIN } from './ttoken-flags.ts'\n`],
    [`<button id="sign-in" className="primary" type="button" onClick=`, `<button id="sign-in" className="primary" type="button" hidden={!TTOKEN_ACCOUNT_LOGIN} onClick=`],
    [`id="api-key" className="secondary"`, `id="api-key" className={TTOKEN_ACCOUNT_LOGIN ? 'secondary' : 'primary'}`],
    [`<button id="back-to-login" className="back" type="button" disabled={busy}`, `<button id="back-to-login" className="back" type="button" hidden={!TTOKEN_ACCOUNT_LOGIN} disabled={busy}`],
  ],
})
replaceTokens({
  name: 'sambutan-teks',
  scopes: ['apps/desktop'],
  pairs: [
    ['Configure official DeepSeek models to start using Harness', 'Add your TTOken Gateway API key to start using TTOken Code'],
    ['配置 DeepSeek 官方模型，即可开始使用', '添加 TTOken Gateway API 密钥，即可开始使用'],
    ['公式のDeepSeekモデルを設定してHarnessを使い始めましょう', 'TTOken GatewayのAPIキーを追加してTTOken Codeを使い始めましょう'],
    ['Configura los modelos oficiales DeepSeek para empezar a utilizar Harness', 'Añade tu clave de API de TTOken Gateway para empezar a usar TTOken Code'],
    ['Configurez les modèles DeepSeek officiels pour commencer à utiliser Harness', 'Ajoutez votre clé API TTOken Gateway pour commencer à utiliser TTOken Code'],
    ['Konfigurieren Sie offizielle DeepSeek-Modelle für die Verwendung von Harness', 'Fügen Sie Ihren TTOken-Gateway-API-Schlüssel hinzu, um TTOken Code zu verwenden'],
    ['Настройте официальные модели DeepSeek, чтобы начать использовать Harness.', 'Добавьте API-ключ TTOken Gateway, чтобы начать работу с TTOken Code.'],
    ['Configure modelos DeepSeek oficiais para começar a usar o Harness', 'Adicione sua chave de API do TTOken Gateway para começar a usar o TTOken Code'],
  ],
})

// 12. Merek di dalam jendela: mark, wordmark, nama build, judul, dan beranda.
//     Komponen FishLogo dan BrandWordmark dipakai sidebar, beranda, dan plugin
//     merek, jadi mengganti isinya mengganti semua kemunculan paus upstream.
const FISH_LOGO = 'packages/client/ui-primitives/src/FishLogo.tsx'
const EMPTY_HERO = 'packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx'
editFile({
  name: 'mark-klien (ukuran)',
  path: FISH_LOGO,
  pairs: [
    [`export const FISH_LOGO_VIEWBOX = { width: 23.16, height: 17.04 }`, `export const FISH_LOGO_VIEWBOX = { width: 56, height: 48 }`],
    [
      `      <path d={FISH_LOGO_PATH} fill="currentColor" />\n`,
      `      <path d={FISH_LOGO_PATH} fill="${KUNYIT}" />\n      <path d="${MARK_BAR}" fill="currentColor" />\n`,
    ],
  ],
})
setQuotedValues({
  name: 'mark-klien (bentuk)',
  paths: [FISH_LOGO],
  pattern: /(export const FISH_LOGO_PATH =\s*)('[^'\n]*')/g,
  value: MARK_BODY,
  expected: 1,
})
// Animasi berenang di beranda memorf path paus; target morf disamakan dengan mark supaya bentuknya tetap.
setQuotedValues({
  name: 'mark-beranda (bentuk)',
  paths: [EMPTY_HERO],
  pattern: /(const HERO_SWIM_(?:UP|DOWN)_PATH =\s*)('[^'\n]*')/g,
  value: MARK_BODY,
  expected: 2,
})
editFile({
  name: 'mark-beranda (warna)',
  path: EMPTY_HERO,
  pairs: [
    [`      <path d={FISH_LOGO_PATH} fill="currentColor">\n`, `      <path d={FISH_LOGO_PATH} fill="${KUNYIT}">\n`],
    [`      </path>\n    </svg>\n`, `      </path>\n      <path d="${MARK_BAR}" fill="currentColor" />\n    </svg>\n`],
  ],
})
copyAssets('wordmark-klien', [
  ['ttoken/client/BrandWordmark.tsx', 'packages/client/ui-primitives/src/BrandWordmark.tsx'],
  ['ttoken/client/running-mark@2x.png', 'packages/client/ui-chat/src/client/assets/running-whale@2x.png'],
])
const CLIENT_LOCALES = ['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'].map(code => `packages/client/locale/src/locales/${code}.ts`)
setQuotedValues({
  name: 'nama-build-klien',
  paths: CLIENT_LOCALES,
  pattern: /('brand\.localBuild': )('[^'\n]*'|"[^"\n]*")/g,
  value: brand.productName,
  expected: CLIENT_LOCALES.length,
})
setQuotedValues({
  name: 'judul-beranda',
  paths: ['packages/client/ui-conversation/src/client/locales.ts'],
  pattern: /('hero\.headline': )('[^'\n]*'|"[^"\n]*")/g,
  value: brand.productName,
  expected: CLIENT_LOCALES.length,
})
replaceTokens({
  name: 'judul-jendela',
  scopes: ['apps/web'],
  pairs: [['DSH Local Build', brand.productName]],
})
// Dekorasi paus piksel di beranda tidak dipasang.
editFile({
  name: 'paus-beranda',
  path: 'packages/client/ui-brand-official/src/client/index.ts',
  pairs: [
    [`import { PixelWhale } from './home-whale/PixelWhale.tsx'\n`, `// TTOken Code: the upstream pixel whale decoration is not mounted.\n`],
    [
      `  ctx.slots.inject('conversation.hero.frame', () => ctx.slots.register({\n    name: 'conversation.hero.frame',\n    id: 'pixel-whale',\n  }, PixelWhale))\n  if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'official') return\n`,
      `  // TTOken Code: only the sidebar brand slots are filled.\n  if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'official') return\n`,
    ],
  ],
})

// 13. Identitas agent di prompt sistem. Upstream membuat model memperkenalkan
//     diri sebagai produk upstream kepada user.
editFile({
  name: 'identitas-agent',
  path: 'packages/core/system-prompt/src/index.ts',
  pairs: [[`text: 'You are an AI agent powered by ${upstream.productName}.',`, `text: 'You are ${brand.productName}, an AI coding agent.',`]],
})

// 14. Teks antarmuka di semua kamus bahasa. Hanya isi literal string yang
//     disentuh, bukan kode. Contoh perintah huruf kecil (`dsh web`) di dalam
//     kurung dihapus, karena perintah itu tidak dipasang untuk user.
rebrandLocaleStrings({
  name: 'teks-antarmuka',
  scopes: ['packages', 'apps/desktop/src', 'apps/desktop/installer/locales', 'apps/web/src'],
  keep: [ATTRIBUTION],
})

// 15. Menu "Manage dsh Command…" dihapus: perintah itu bernama upstream.
editFile({
  name: 'menu-perintah-cli',
  path: 'apps/desktop/src/main.ts',
  pairs: [[
    `    ...process.platform === 'darwin' || process.platform === 'win32'\n      ? [{ label: currentDesktopLocale().messages.cliCommandMenu, click: () => { void commandManager.show() } }] : [],\n`,
    `    // TTOken Code: the upstream-named command manager is not offered.\n`,
  ]],
})

// 16. Layar sambutan: mark di tengah, nama produk di bawahnya, satu baris
//     atribusi. Tagline upstream dihapus.
copyAssets('mark-sambutan', [['ttoken/renderer/welcome-mark.svg', 'apps/desktop/renderer/assets/welcome-mark.svg']])
editFile({
  name: 'sambutan-tata-letak',
  path: 'apps/desktop/src/client/WelcomePage.tsx',
  pairs: [
    [
      `<img className="brand" src="assets/welcome-brand.svg" alt={m.welcomeBrand} width="472" height="40" />`,
      `<img className="brand" src="assets/welcome-brand.svg" alt={m.welcomeBrand} width="472" height="40" hidden={page === 'entry'} />`,
    ],
    [
      `<h1 id="welcome-heading"><span>{m.welcomeTaglineBefore}</span><em>{m.welcomeTaglineBrand}</em><span>{m.welcomeTaglineAfter}</span></h1>`,
      `<img className="mark" src="assets/welcome-mark.svg" alt="" width="96" height="82" />\n        <h1 id="welcome-heading">{m.welcomeBrand}</h1>`,
    ],
  ],
})
editFile({
  name: 'sambutan-gaya',
  path: 'apps/desktop/renderer/welcome.css',
  pairs: [[
    `:lang(en) .tagline em {\n  font-size: inherit;\n}\n`,
    `:lang(en) .tagline em {\n  font-size: inherit;\n}\n\n/* TTOken Code: centered mark above the product name, with one attribution line. */\n.tagline .mark {\n  display: block;\n  width: 96px;\n  height: 82px;\n  margin: 0 auto 20px;\n  user-select: none;\n  -webkit-user-drag: none;\n}\n\n.tagline h1 {\n  color: var(--dsw-alias-label-primary);\n  font-family: var(--dsw-font-family-brand);\n  font-size: 30px;\n  font-weight: 600;\n  line-height: 38px;\n}\n\n.tagline p {\n  margin-top: 12px;\n  font-size: 13px;\n  font-weight: 400;\n  line-height: 18px;\n}\n`,
  ]],
})
setQuotedValues({
  name: 'sambutan-atribusi',
  paths: ['apps/desktop/src/locale.ts'],
  pattern: /(welcomeDescription: )('[^'\n]*'|"[^"\n]*")/g,
  value: ATTRIBUTION,
  expected: 8,
})

// 17. Terjemahan reasoning tetap memakai Bing atau Google; rute berbayar DeepSeek Flash tidak ditawarkan.
editFile({
  name: 'terjemahan-tanpa-deepseek',
  path: 'packages/experimental/translator/src/deepseek.ts',
  pairs: [[
    `  for (const provider of ['deepseek-account', 'deepseek-official'] as const) {\n`,
    `  // TTOken Code: the paid DeepSeek Flash routes are never offered.\n  for (const provider of [] as ('deepseek-account' | 'deepseek-official')[]) {\n`,
  ]],
})

// 18. Prompt model di plugin yang dinyalakan lagi: konteks mode Creator dan rekomendasi.
rebrandLocaleStrings({
  name: 'prompt-plugin',
  files: [
    'packages/context/harness-dev-context/src/index.ts',
    'packages/experimental/plugin-recommendations/src/index.ts',
    'packages/experimental/plugin-recommendations/src/skill.ts',
    'packages/experimental/plugin-recommendations/skills/official-plugins.md',
    'packages/experimental/creation-recommendations/src/index.ts',
    'packages/experimental/creation-recommendations/skills/personalized-pages.md',
  ],
  keep: [ATTRIBUTION],
})

// 19. Halaman Plugins: nama paket upstream tidak ditampilkan, dan paket yang tetap
//     mati tidak didaftar sama sekali.
const PLUGIN_MANAGER = 'packages/client/ui-plugin-manager/src/client'
const UPSTREAM_SCOPE = `'@deepseek-ai/'`
writeGenerated('plugins-daftar (modul)', `${PLUGIN_MANAGER}/ttoken-hidden.ts`, HIDDEN_MODULE)
editFile({
  name: 'plugins-daftar',
  path: `${PLUGIN_MANAGER}/manager-store.ts`,
  pairs: [
    [
      `import { shortName } from './presentation.ts'\n`,
      `import { shortName } from './presentation.ts'\nimport { TTOKEN_HIDDEN_PACKAGES } from './ttoken-hidden.ts'\n`,
    ],
    [
      `/**\n * The order the list shows packages in: by the short name a person reads, so a\n`,
      `/**\n * Whether TTOken Code lists a package or module.\n * @param name - package name or module specifier.\n * @returns false for a hidden package or one of its subpaths.\n */\nfunction ttokenListed(name: string): boolean {\n  return !TTOKEN_HIDDEN_PACKAGES.has(name.split('/').slice(0, 2).join('/'))\n}\n\n/**\n * The order the list shows packages in: by the short name a person reads, so a\n`,
    ],
    [
      `packages: sortPackages(bundles.value.map(bundle => packageView(bundle, plugins.value))),`,
      `packages: sortPackages(bundles.value.map(bundle => packageView(bundle, plugins.value))\n            .filter(view => ttokenListed(view.name))\n            .map(view => ({ ...view, rows: view.rows.filter(row => ttokenListed(row.moduleName)) }))),`,
    ],
  ],
})
editFile({
  name: 'plugins-judul-cadangan',
  path: `${PLUGIN_MANAGER}/presentation.ts`,
  pairs: [
    [
      `title: pkg.meta?.title === undefined ? pkg.name : resolveText(pkg.meta.title),`,
      `title: pkg.meta?.title === undefined ? (pkg.name.startsWith(${UPSTREAM_SCOPE}) ? shortName(pkg.name) : pkg.name) : resolveText(pkg.meta.title),`,
    ],
    [
      `title: row.meta?.title === undefined ? row.moduleName : resolveText(row.meta.title),`,
      `title: row.meta?.title === undefined ? (row.moduleName.startsWith(${UPSTREAM_SCOPE}) ? shortName(row.moduleName) : row.moduleName) : resolveText(row.meta.title),`,
    ],
  ],
})
editFile({
  name: 'plugins-nama-paket',
  path: `${PLUGIN_MANAGER}/PluginManagerPage.tsx`,
  pairs: [
    [
      `fuzzy: [row.rowId, row.moduleName, ...localizedValues(row.meta?.title)],`,
      `fuzzy: [row.rowId, ...row.moduleName.startsWith(${UPSTREAM_SCOPE}) ? [] : [row.moduleName], ...localizedValues(row.meta?.title)],`,
    ],
    [
      `{title === row.rowId ? null : <code className={css.rowModule}>{row.rowId}</code>}`,
      `{title === row.rowId || row.moduleName.startsWith(${UPSTREAM_SCOPE}) ? null : <code className={css.rowModule}>{row.rowId}</code>}`,
    ],
    [
      `{title === row.moduleName ? null : <code className={css.rowModule}>{row.moduleName}</code>}`,
      `{title === row.moduleName || row.moduleName.startsWith(${UPSTREAM_SCOPE}) ? null : <code className={css.rowModule}>{row.moduleName}</code>}`,
    ],
    [
      `{rowTitle === row.rowId ? null : <p className={css.detailName}><code>{row.rowId}</code></p>}`,
      `{rowTitle === row.rowId || row.moduleName.startsWith(${UPSTREAM_SCOPE}) ? null : <p className={css.detailName}><code>{row.rowId}</code></p>}`,
    ],
    [
      `        <p className={css.detailName}><code>{row.moduleName}</code></p>\n`,
      `        {row.moduleName.startsWith(${UPSTREAM_SCOPE}) ? null : <p className={css.detailName}><code>{row.moduleName}</code></p>}\n`,
    ],
    [
      `<p className={css.detailName}><code data-plugin-name>{pkg.name}</code></p>`,
      `{pkg.name.startsWith(${UPSTREAM_SCOPE}) ? null : <p className={css.detailName}><code data-plugin-name>{pkg.name}</code></p>}`,
    ],
    [
      `{pkg.installTarget === undefined ? null : (`,
      `{pkg.installTarget === undefined || pkg.name.startsWith(${UPSTREAM_SCOPE}) ? null : (`,
    ],
  ],
})
writeGenerated('rekomendasi-plugin-tersembunyi (modul)', 'packages/experimental/plugin-recommendations/src/ttoken-hidden.ts', HIDDEN_MODULE)
editFile({
  name: 'rekomendasi-plugin-tersembunyi (tsconfig)',
  path: 'packages/experimental/plugin-recommendations/tsconfig.json',
  pairs: [[`    "src/skill.ts"\n`, `    "src/skill.ts",\n    "src/ttoken-hidden.ts"\n`]],
})
editFile({
  name: 'rekomendasi-plugin-tersembunyi',
  path: 'packages/experimental/plugin-recommendations/src/skill.ts',
  pairs: [
    [
      `import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager/types'\n`,
      `import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager/types'\nimport { TTOKEN_HIDDEN_PACKAGES } from './ttoken-hidden.ts'\n`,
    ],
    [
      `return bundle.official && bundle.optional && bundle.availability !== 'missing'`,
      `return bundle.official && bundle.optional && bundle.availability !== 'missing' && !TTOKEN_HIDDEN_PACKAGES.has(bundle.name)`,
    ],
  ],
})
const PLUGIN_MANAGER_LOCALES = `${PLUGIN_MANAGER}/locales.ts`
const EXAMPLE_PACKAGE = '@author/plugin-name'
// Urutan blok bahasa di berkas: zh, en, ja, es, fr, de, ru, pt.
setLocaleValues({
  name: 'plugins-contoh-paket',
  path: PLUGIN_MANAGER_LOCALES,
  key: 'installSpecPlaceholder',
  values: [`例如 ${EXAMPLE_PACKAGE}`, `for example ${EXAMPLE_PACKAGE}`, `例: ${EXAMPLE_PACKAGE}`, `por ejemplo ${EXAMPLE_PACKAGE}`,
    `par exemple ${EXAMPLE_PACKAGE}`, `zum Beispiel ${EXAMPLE_PACKAGE}`, `например ${EXAMPLE_PACKAGE}`, `por exemplo ${EXAMPLE_PACKAGE}`],
})
setLocaleValues({
  name: 'plugins-contoh-paket-panduan',
  path: PLUGIN_MANAGER_LOCALES,
  key: 'installGuideIdExample',
  values: Array(8).fill(EXAMPLE_PACKAGE),
})
setLocaleValues({
  name: 'plugins-petunjuk-paket',
  path: PLUGIN_MANAGER_LOCALES,
  key: 'installGuideIdHint',
  values: [
    '插件包名即 npm 包名，也就是社区插件 README 安装命令中 pnpm add 之后的部分。',
    "The plugin package name is the npm package name: the part after pnpm add in a community plugin's README install command.",
    'プラグインパッケージ名とはnpmパッケージ名です。コミュニティプラグインのREADMEのインストールコマンドにあるpnpm addの後ろの部分です。',
    'El nombre del paquete del complemento es el nombre del paquete npm: la parte después de pnpm add en el comando de instalación del README de un complemento comunitario.',
    "Le nom du package du plugin est le nom du package npm : la partie après pnpm add dans la commande d'installation du README d'un plugin communautaire.",
    'Der Plugin-Paketname ist der npm-Paketname: der Teil nach pnpm add im README-Installationsbefehl eines Community-Plugins.',
    'Имя пакета плагина — это имя пакета npm: часть после pnpm add в команде установки из README плагина сообщества.',
    'O nome do pacote do plug-in é o nome do pacote npm: a parte após pnpm add no comando de instalação do README de um plug-in da comunidade.',
  ],
})

// 20. Login akun TTOken. Plugin akun upstream diarahkan ke rute
//     `/api/v1/code/desktop` di ttoken.dev (docs/CODE-DESKTOP.md di repo TTOken).
//     Key perangkat hasil login juga menjadi API key rute TTOken Gateway, jadi
//     rute akun DeepSeek (llm-deepseek-account) tetap mati. Halaman Pemakaian
//     dan Isi saldo dibuka di browser. Plugin akun menyala lewat `accountLogin`
//     di ttoken/brand.json (lihat ttoken/layer/account.patch.yml).
writeGenerated('akun-key-gateway (modul)', 'packages/account/deepseek-account/src/ttoken-key-mirror.ts',
  `// Generated by ttoken/apply-brand.mjs from ttoken/host/account-key-mirror.ts; edit that file instead.\n${readFileSync(join(ROOT, 'ttoken', 'host', 'account-key-mirror.ts'), 'utf8')}`)
editFile({
  name: 'akun-key-gateway (ekspor)',
  path: 'packages/account/deepseek-account/src/index.ts',
  pairs: [[
    `export type * from './types.ts'\n`,
    `export type * from './types.ts'\nexport { installTtokenAccountKey } from './ttoken-key-mirror.ts'\n`,
  ]],
})
editFile({
  name: 'akun-key-gateway (pasang)',
  path: 'apps/desktop-host/src/index.ts',
  pairs: [
    [
      `import { installPlatformSessionPublisher } from './platform-session.ts'\n`,
      `import { installPlatformSessionPublisher } from './platform-session.ts'\nimport { installTtokenAccountKey } from '@deepseek-ai/dsh-deepseek-account'\n`,
    ],
    [
      `    if (process.connected) process.send?.({ type: 'platform-session', session })\n  })\n`,
      `    if (process.connected) process.send?.({ type: 'platform-session', session })\n  })\n  installTtokenAccountKey(ctx, TTOKEN_GATEWAY_KEY_REF)\n`,
    ],
  ],
})
replaceTokens({
  name: 'akun-rute',
  // Test ikut diganti: pemeriksaan tipe agregat saat build membaca literal rute di test.
  scopes: ['packages/account/deepseek-account/src', 'packages/account/deepseek-account/tests', 'apps/desktop/src/host-process.ts'],
  pairs: [
    ['/auth-api/v0/dsh/', '/api/v1/code/desktop/'],
    ['/auth-api/v0/users/current', '/api/v1/code/desktop/me'],
    ['/api/v0/users/get_user_summary', '/api/v1/code/desktop/wallet'],
    ['/api/v0/users/notifications/', '/api/v1/code/desktop/notifications/'],
    ['/auth-api/v0/users/logout', '/api/v1/code/desktop/logout'],
    [`'/dsh/authorize'`, `'/code/authorize'`],
    [`'/dsh/authorized'`, `'/code/authorized'`],
    [`'x-dsh-auth-token'`, `'x-ttoken-code-token'`],
    [`new URL('/usage', this.origin)`, `new URL('/dashboard/gateway?tab=usage', this.origin)`],
    [`new URL('/top_up', this.origin)`, `new URL('/dashboard/wallet', this.origin)`],
  ],
})
editFile({
  name: 'akun-rupiah (tipe)',
  path: 'packages/account/deepseek-account/src/types.ts',
  pairs: [[`readonly currency: 'CNY' | 'USD'\n`, `readonly currency: 'CNY' | 'USD' | 'IDR'\n`]],
})
editFile({
  name: 'akun-rupiah (validasi)',
  path: 'packages/account/deepseek-account/src/details.ts',
  pairs: [[`currency: z.enum(['CNY', 'USD'])`, `currency: z.enum(['CNY', 'USD', 'IDR'])`]],
})
editFile({
  name: 'akun-rupiah (format)',
  path: 'packages/client/ui-settings-account/src/client/formatBalance.ts',
  pairs: [
    [
      `export function formatBalance(amount: string, symbol: '¥' | '$'): string {\n  const value = new Big(amount)\n`,
      `export function formatBalance(amount: string, symbol: '¥' | '$' | 'Rp'): string {\n  const value = new Big(amount)\n  if (symbol === 'Rp') return formatRupiah(value)\n`,
    ],
    [
      `function addCommas(value: string): string {`,
      `/**
 * TTOken Code: the symbol of a wallet currency.
 * @param currency - wallet currency.
 * @returns the symbol {@link formatBalance} accepts.
 */
export function currencySymbol(currency: 'CNY' | 'USD' | 'IDR'): '¥' | '$' | 'Rp' {
  return currency === 'IDR' ? 'Rp' : currency === 'CNY' ? '¥' : '$'
}

/**
 * TTOken Code: whole rupiah with dot grouping, rounded toward zero, such as \`Rp 48.500\`.
 * @param value - balance in rupiah.
 * @returns signed rupiah text.
 */
function formatRupiah(value: Big): string {
  const whole = value.round(0, Big.roundDown)
  const digits = whole.abs().toFixed(0).replace(/\\B(?=(\\d{3})+(?!\\d))/g, '.')
  return \`\${whole.lt(0) ? '-' : ''}Rp \${digits}\`
}

function addCommas(value: string): string {`,
    ],
  ],
})
editFile({
  name: 'akun-rupiah (impor)',
  path: 'packages/client/ui-settings-account/src/client/AccountSection.tsx',
  pairs: [
    [`import { formatBalance } from './formatBalance.ts'\n`, `import { currencySymbol, formatBalance } from './formatBalance.ts'\n`],
    [`href={new URL('/', state.links.usageUrl).href}`, `href={new URL('/dashboard/settings', state.links.usageUrl).href}`],
  ],
})
replaceTokens({
  name: 'akun-rupiah (simbol)',
  scopes: ['packages/client/ui-settings-account/src/client/AccountSection.tsx'],
  pairs: [[`formatBalance(wallet.balance, wallet.currency === 'CNY' ? '¥' : '$')`, `formatBalance(wallet.balance, currencySymbol(wallet.currency))`]],
})
editFile({
  name: 'akun-halaman-di-browser (jembatan)',
  path: 'apps/desktop/src/preload-app.ts',
  pairs: [
    [
      `import { PLATFORM_IPC } from './platform-ipc.ts'\n`,
      `// TTOken Code: the embedded Platform view is not exposed, so its IPC channel is not imported.\n`,
    ],
    [
      `  contextBridge.exposeInMainWorld('dshPlatform', {
    open: (page: 'usage' | 'top-up', bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke(PLATFORM_IPC.open, page, bounds),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke(PLATFORM_IPC.bounds, bounds),
    close: () => ipcRenderer.invoke(PLATFORM_IPC.close),
  })
`,
      `  // TTOken Code: Usage and Top up open the TTOken dashboard in the browser; no dshPlatform bridge.\n`,
    ],
  ],
})
editFile({
  name: 'akun-halaman-di-browser (onboarding)',
  path: 'packages/client/ui-settings-account/src/client/DesktopOnboarding.tsx',
  pairs: [[
    `  const canRecharge = openPlatformPage !== undefined
  const recharge = () => {
    setDialog(null)
    releaseRecharge.current?.()
`,
    `  // TTOken Code: without an embedded Platform view, Top up opens the TTOken wallet page in the browser.
  const topUpUrl = openPlatformPage === undefined ? account.view?.links.topUpUrl : undefined
  const canRecharge = openPlatformPage !== undefined || topUpUrl !== undefined
  const recharge = () => {
    setDialog(null)
    releaseRecharge.current?.()
    if (topUpUrl !== undefined) { window.open(topUpUrl, '_blank', 'noopener,noreferrer'); return }
`,
  ]],
})
const LANGUAGE_CODES = ['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh']
rebrandLocaleStrings({
  name: 'akun-teks',
  files: [
    'packages/client/ui-settings-account/src/client/locales.ts',
    ...LANGUAGE_CODES.flatMap(code => [
      `packages/client/ui-settings-account/locale/${code}.json`,
      `packages/account/deepseek-account/locale/${code}.json`,
    ]),
  ],
  keep: [ATTRIBUTION],
  edits: [[/\bDeepSeek\b/g, 'TTOken']],
})
editFile({
  name: 'akun-deskripsi (layanan)',
  path: 'packages/account/deepseek-account/package.json',
  pairs: [[
    `"description": "Sign in to DeepSeek and manage account credentials and notifications"`,
    `"description": "Sign in to TTOken and manage account credentials and notifications"`,
  ]],
})
editFile({
  name: 'akun-deskripsi (pengaturan)',
  path: 'packages/client/ui-settings-account/package.json',
  pairs: [[
    `"description": "Manage DeepSeek login and open Platform billing pages"`,
    `"description": "Manage TTOken login and open TTOken billing pages"`,
  ]],
})
// Urutan blok bahasa di kamus akun dan kamus desktop: en, zh, ja, es, fr, de, ru, pt.
const ACCOUNT_LOCALES = 'packages/client/ui-settings-account/src/client/locales.ts'
setLocaleValues({
  name: 'akun-label-saldo',
  path: ACCOUNT_LOCALES,
  key: 'balance',
  values: ['Balance', '余额', '残高', 'Saldo', 'Solde', 'Guthaben', 'Баланс', 'Saldo'],
})
setLocaleValues({
  name: 'akun-lihat-saldo',
  path: ACCOUNT_LOCALES,
  key: 'balanceUnavailable',
  values: ['View on TTOken', '前往 TTOken 查看', 'TTOken で表示', 'Ver en TTOken', 'Afficher sur TTOken', 'Auf TTOken ansehen', 'Посмотреть на TTOken', 'Ver no TTOken'],
})
setLocaleValues({
  name: 'sambutan-tombol-masuk',
  path: 'apps/desktop/src/locale.ts',
  key: 'welcomeSignIn',
  values: ['Sign in with TTOken', '使用 TTOken 账号登录', 'TTOken でログイン', 'Iniciar sesión con TTOken', 'Se connecter avec TTOken', 'Mit TTOken anmelden', 'Войти через TTOken', 'Entrar com o TTOken'],
})

// 21. Pencarian web lewat TTOken Gateway. Plugin pencarian web upstream memakai
//     `POST /v1/tools/search` di api.ttoken.dev dengan API key rute Gateway
//     (ttoken/layer/web.patch.yml, saklar `webSearch`). TTOken tidak menyediakan
//     pengambilan halaman, jadi penyedia Fetch plugin itu tidak didaftarkan;
//     `web_fetch` tetap memakai web-fetch-http di perangkat user.
editFile({
  name: 'pencarian-web (tanpa fetch)',
  path: 'packages/web/web-deepseek-api/src/index.ts',
  pairs: [[
    `  ctx.web.registerFetchProvider({
    id: fetchApi.id,
    description: fetchApi.description,
    available: () => fetchApi.available(),
    ready: ready('fetch'),
    fetch: (request, signal) => fetchApi.fetch(request, signal),
  })
`,
    `  // TTOken Code: TTOken serves search only; web-fetch-http fetches pages on the user's device.
  void fetchApi
`,
  ]],
})
rebrandLocaleStrings({
  name: 'pencarian-web (teks)',
  files: [
    ...['index.ts', 'search.ts', 'fetch.ts', 'transport.ts'].map(file => `packages/web/web-deepseek-api/src/${file}`),
    ...LANGUAGE_CODES.map(code => `packages/web/web-deepseek-api/locale/${code}.json`),
  ],
  keep: [ATTRIBUTION],
  edits: [[/\bDeepSeek\b/g, 'TTOken']],
})

/**
 * Baca potongan sumber dari `ttoken/client/`.
 * @param {string} path Path relatif terhadap `ttoken/client/`.
 * @returns {string} Isi berkas.
 */
function clientPart(path) {
  return readFileSync(join(ROOT, 'ttoken', 'client', path), 'utf8')
}

/**
 * Baca potongan sumber dari `ttoken/forge/`.
 * @param path Path relatif terhadap `ttoken/forge/`.
 * @returns Isi berkas.
 */
function forgePart(path) {
  return readFileSync(join(ROOT, 'ttoken', 'forge', path), 'utf8')
}

/**
 * Baca berkas paket perangkat Android dari `ttoken/device/`.
 * @param path Path relatif terhadap `ttoken/device/`.
 * @returns Isi berkas.
 */
function devicePart(path) {
  return readFileSync(join(ROOT, 'ttoken', 'device', path), 'utf8')
}

/** Potongan lockfile untuk paket perangkat Android, dihasilkan pnpm (lihat aturan 27). */
const DEVICE_LOCK_PAIRS = JSON.parse(readFileSync(join(ROOT, 'ttoken', 'device', 'lock-pairs.json'), 'utf8'))

// 22. Palet TTOken Code dari desain desktop: permukaan putih hangat dengan tombol
//     hitam di skema terang, permukaan hitam netral di skema gelap. Dipasang
//     sebagai satu lapisan override token, jadi semua komponen ikut tanpa CSS per komponen.
writeGenerated('palet', 'packages/client/ui-theme/src/client/ttoken-palette.ts', clientPart('palette.ts'))
editFile({
  name: 'palet (pasang)',
  path: 'packages/client/ui-theme/src/client/index.ts',
  pairs: [
    [
      `import { installThemeStyles } from './styles.ts'\n`,
      `import { installThemeStyles } from './styles.ts'\nimport { TTOKEN_PALETTE, TTOKEN_PALETTE_SOURCE } from './ttoken-palette.ts'\n`,
    ],
    [
      `  const theme = new ThemeRuntime(ctx, host)\n`,
      `  const theme = new ThemeRuntime(ctx, host)\n  // TTOken Code: the distribution palette is the first override layer, so a registered theme can still restyle it.\n  ctx.effect(() => theme.overrideTokens(TTOKEN_PALETTE_SOURCE, TTOKEN_PALETTE), 'ui-theme: TTOken Code palette')\n`,
    ],
  ],
})

// 23. Fon desain: Inter untuk teks, JetBrains Mono untuk kode. Keduanya ikut
//     dibundel (lisensi SIL OFL) supaya Windows yang tidak memasangnya tampil sama.
const FONT_FILES = [
  'inter-latin-wght.woff2', 'inter-latin-ext-wght.woff2',
  'jetbrains-mono-latin-wght.woff2', 'jetbrains-mono-latin-ext-wght.woff2',
  'Inter-OFL.txt', 'JetBrainsMono-OFL.txt',
]
copyAssets('fon (berkas)', FONT_FILES.map(file => [`ttoken/fonts/${file}`, `packages/client/ui-theme/src/styles/${file}`]))
const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'
const LATIN_EXT = 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF'
const fontFace = (family, weights, file, range) => `
@font-face {
  font-family: '${family}';
  font-style: normal;
  font-weight: ${weights};
  font-display: swap;
  src: url(./${file}) format('woff2');
  unicode-range: ${range};
}
`
editFile({
  name: 'fon (font-face)',
  path: 'packages/client/ui-theme/src/styles/brand-font.css',
  pairs: [[
    `  src: url(./montserrat-medium.woff2) format('woff2');\n}\n`,
    `  src: url(./montserrat-medium.woff2) format('woff2');\n}\n`
      + `\n/* TTOken Code text and code fonts; SIL Open Font License in Inter-OFL.txt and JetBrainsMono-OFL.txt. */`
      + fontFace('Inter', '100 900', 'inter-latin-wght.woff2', LATIN)
      + fontFace('Inter', '100 900', 'inter-latin-ext-wght.woff2', LATIN_EXT)
      + fontFace('JetBrains Mono', '100 800', 'jetbrains-mono-latin-wght.woff2', LATIN)
      + fontFace('JetBrains Mono', '100 800', 'jetbrains-mono-latin-ext-wght.woff2', LATIN_EXT),
  ]],
})
editFile({
  name: 'fon (tumpukan bawaan)',
  path: 'packages/client/ui-theme/src/styles/base.css',
  pairs: [
    [`  --dsh-font-family-text-default: -apple-system,`, `  --dsh-font-family-text-default: 'Inter', -apple-system,`],
    [`  --dsh-font-family-code-default: 'SF Mono', 'JetBrains Mono', 'Fira Code',`, `  --dsh-font-family-code-default: 'JetBrains Mono', 'SF Mono', 'Fira Code',`],
  ],
})
editFile({
  name: 'fon (salin ke lib)',
  path: 'packages/client/ui-theme/tsdown.config.ts',
  pairs: [[`from: 'src/styles/{brand-font.css,montserrat-*.woff2,Montserrat-OFL.txt}',`, `from: 'src/styles/{brand-font.css,*.woff2,*-OFL.txt}',`]],
})
editFile({
  name: 'fon (jendela sambutan)',
  path: 'apps/desktop/tsdown.config.ts',
  pairs: [[
    `'montserrat-medium.woff2', 'Montserrat-OFL.txt']`,
    `'montserrat-medium.woff2', 'Montserrat-OFL.txt', ${FONT_FILES.map(file => `'${file}'`).join(', ')}]`,
  ]],
})

// 24. Composer sesuai desain desktop: chip opsi di atas kartu (izin, lalu chip
//     plugin di `conversation.input.left`, lalu mark), tombol kirim ↵ di dalam
//     kartu, mode dan model di bawahnya. Logika InputBar upstream tidak diubah;
//     hanya susunan elemen dan gayanya.
editFile({
  name: 'composer (chip)',
  path: 'packages/client/ui-conversation/src/client/skeleton/InputBar.tsx',
  pairs: [[
    `      {/* Trigger clicks land on the card, not the editor: the toolbar row's\n`,
    clientPart('composer/chips.tsx.part').replace('TTOKEN_MARK_BODY', MARK_BODY).replace('TTOKEN_MARK_BAR', MARK_BAR)
      + `      {/* Trigger clicks land on the card, not the editor: the toolbar row's\n`,
  ]],
})
replaceRegion({
  name: 'composer (susunan)',
  path: 'packages/client/ui-conversation/src/client/skeleton/InputBar.tsx',
  start: `        <DraftEditor\n          classNames={css}\n`,
  end: `      <div className={css.dock} data-composer-dock>`,
  content: clientPart('composer/row.tsx.part'),
})
editFile({
  name: 'composer (gaya)',
  path: 'packages/client/ui-conversation/src/client/skeleton/InputBar.module.css',
  pairs: [[
    `.activityExpanded { flex: 1; min-width: 0; }\n`,
    `.activityExpanded { flex: 1; min-width: 0; }\n${clientPart('composer/composer.css.part')}`,
  ]],
})
setLocaleValues({
  name: 'composer (placeholder)',
  path: 'packages/client/ui-conversation/src/client/locales.ts',
  key: 'placeholder.default',
  values: [
    '让 Code 解答，或描述一项修改', 'Ask Code or describe a change', 'Code に質問するか、変更内容を説明', 'Pregunta a Code o describe un cambio',
    'Demandez à Code ou décrivez une modification', 'Frag Code oder beschreibe eine Änderung', 'Спросите Code или опишите изменение', 'Pergunte ao Code ou descreva uma mudança',
  ],
})

// 24b. Menu mode di bawah composer: "Agent mode" atau "Plan mode". Upstream hanya
//      menampilkan chip saat mode rencana aktif dan masuknya lewat /plan; di sini
//      kedua mode dipilih dari satu menu, memakai perintah /plan dan /plan off yang sama.
editFile({
  name: 'mode (impor)',
  path: 'packages/client/ui-plan/src/client/PlanModeControl.tsx',
  pairs: [
    [`import { useEffect, useRef, useState } from 'react'\n`, `import { useEffect, useRef, useState } from 'react'\nimport type { ReactNode } from 'react'\n`],
    [
      `import { IconCloseCircleFillRegular, IconPlanOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'\n`,
      `import { IconChevronDownOutlineRegular, IconPlanOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'\nimport type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'\n`,
    ],
    [
      ` * Plan-mode status over the host-computed \`plan\` projection. The chip renders\n * only while the effective target is plan mode (\`pending ? !active : active\`\n * — a folded host value, not client optimism) and executes /plan off.\n`,
      ` * Mode menu over the host-computed \`plan\` projection: the trigger names the\n * effective target (\`pending ? !active : active\`, a folded host value, not\n * client optimism), and choosing the other mode executes /plan or /plan off.\n`,
    ],
  ],
})
replaceRegion({
  name: 'mode (komponen)',
  path: 'packages/client/ui-plan/src/client/PlanModeControl.tsx',
  start: `export function PlanChip({ useProjection, locked, exitPlanMode, t }: PlanChipProps) {\n`,
  end: '',
  content: clientPart('plan/PlanChip.tsx.part'),
})
editFile({
  name: 'mode (gaya)',
  path: 'packages/client/ui-plan/src/client/PlanModeControl.module.css',
  pairs: [[`.chip:disabled {\n  opacity: 0.6;\n  cursor: default;\n}\n`, `.chip:disabled {\n  opacity: 0.6;\n  cursor: default;\n}\n${clientPart('plan/PlanModeControl.css.part')}`]],
})
editFile({
  name: 'mode (masuk rencana)',
  path: 'packages/client/ui-plan/src/client/index.ts',
  pairs: [
    [
      `  exitPlanMode: () => Promise<string | null>\n}\n`,
      `  exitPlanMode: () => Promise<string | null>\n  /**\n   * Enter plan mode by executing /plan without a message.\n   * @returns null on admitted execution; a user-visible failure line otherwise.\n   */\n  enterPlanMode: () => Promise<string | null>\n}\n`,
    ],
    [
      `        if (result.value === undefined) return 'unknown command: /plan off'\n        return null\n      },\n`,
      `        if (result.value === undefined) return 'unknown command: /plan off'\n        return null\n      },\n      enterPlanMode: async () => {\n        const result = await ctx.remote.commands.execute(sessionId, '/plan', [])\n        if (!result.ok) return \`\${result.error.message} (\${result.error.code})\`\n        if (result.value === undefined) return 'unknown command: /plan'\n        return null\n      },\n`,
    ],
  ],
})
editFile({
  name: 'mode (uji: persiapan)',
  path: 'packages/client/ui-plan/tests/plan-mode-control.client.spec.tsx',
  pairs: [
    [
      ` * PlanChip over the \`plan\` projection: nothing renders while the capability\n * is absent or the effective target is the default mode; while plan mode is\n * the target, the chip executes /plan off and remains visible through failures\n * until the projection confirms the exit.\n`,
      ` * PlanChip over the \`plan\` projection: nothing renders while the capability\n * is absent; otherwise the trigger names the effective target, and choosing\n * the other mode executes /plan or /plan off, reporting failures in place\n * until the projection confirms the change.\n`,
    ],
    [
      `  exitPlanMode = vi.fn(() => Promise.resolve<string | null>(null)),\n  locked = false,\n`,
      `  exitPlanMode = vi.fn(() => Promise.resolve<string | null>(null)),\n  enterPlanMode = vi.fn(() => Promise.resolve<string | null>(null)),\n  locked = false,\n`,
    ],
    [
      `  const props = { useProjection, locked, exitPlanMode, t } as unknown as PlanChipProps\n  const view = render(<PlanChip {...props} />)\n  return { store, exitPlanMode, view }\n`,
      `  const props = { useProjection, locked, exitPlanMode, enterPlanMode, t } as unknown as PlanChipProps\n  const view = render(<PlanChip {...props} />)\n  return { store, exitPlanMode, enterPlanMode, view }\n`,
    ],
  ],
})
replaceRegion({
  name: 'mode (uji: perilaku)',
  path: 'packages/client/ui-plan/tests/plan-mode-control.client.spec.tsx',
  start: `const chip = () => screen.getByRole('button', { name: '计划模式已开启，按下关闭' })\n`,
  end: '',
  content: clientPart('plan/plan-mode-control.spec.part'),
})
const MODE_COPY = {
  zh: ['智能体模式', '计划模式', '读取、修改并运行命令', '先写计划，不做修改', '模式：{name}', '进入计划模式失败'],
  en: ['Agent mode', 'Plan mode', 'Reads, edits and runs commands', 'Writes a plan first, changes nothing', 'Mode: {name}', 'Failed to enter plan mode'],
  ja: ['エージェントモード', '計画モード', '読み取り、編集、コマンド実行', '先に計画を書き、変更はしない', 'モード: {name}', '計画モードに入れませんでした'],
  es: ['Modo agente', 'Modo plan', 'Lee, edita y ejecuta comandos', 'Primero escribe un plan, no cambia nada', 'Modo: {name}', 'No se pudo entrar en el modo de plan'],
  fr: ['Mode agent', 'Mode Plan', 'Lit, modifie et exécute des commandes', 'Rédige d’abord un plan, ne modifie rien', 'Mode : {name}', 'Impossible d’activer le mode Plan'],
  de: ['Agentenmodus', 'Planmodus', 'Liest, bearbeitet und führt Befehle aus', 'Schreibt zuerst einen Plan, ändert nichts', 'Modus: {name}', 'Der Planmodus konnte nicht gestartet werden'],
  ru: ['Режим агента', 'Режим планирования', 'Читает, изменяет и выполняет команды', 'Сначала пишет план, ничего не меняет', 'Режим: {name}', 'Не удалось включить режим планирования.'],
  pt: ['Modo agente', 'Modo de planejamento', 'Lê, edita e executa comandos', 'Escreve um plano primeiro, não altera nada', 'Modo: {name}', 'Falha ao entrar no modo de plano'],
}
const MODE_KEYS = ['mode.agent', 'mode.plan', 'mode.agent.note', 'mode.plan.note', 'mode.aria', 'mode.enterFailed']
{
  const path = 'packages/client/ui-plan/src/client/locales.ts'
  const text = readFileSync(join(ROOT, path), 'utf8')
  // Setiap baris 'chip.exitFailed' mendapat kunci baru dari bahasa blok tempatnya berada.
  const blocks = [...text.matchAll(/^export const (\w+) = \{$/gm)].map(match => ({ at: match.index, code: match[1] }))
  const exits = [...text.matchAll(/^ {2}'chip\.exitFailed': '[^'\n]*',\n/gm)]
    .map(match => ({ line: match[0], code: blocks.filter(block => block.at < match.index).pop()?.code }))
  if (exits.length !== Object.keys(MODE_COPY).length || exits.some(exit => MODE_COPY[exit.code] === undefined)) {
    failures.push(`mode (teks): blok bahasa di ${path} tidak cocok dengan MODE_COPY; upstream berubah, perbarui aturannya`)
  } else {
    editFile({
      name: 'mode (teks)',
      path,
      pairs: exits.map(({ line, code }) => [line, line + MODE_KEYS.map((key, slot) => `  '${key}': '${MODE_COPY[code][slot]}',\n`).join('')]),
    })
  }
}

// 24c. Chip folder dan cabang Git di baris opsi composer. Cabang dibaca dari berkas
//      HEAD lewat Remote workspaceFiles yang sudah ada, jadi tidak ada layanan Host baru.
for (const file of ['TtokenChips.tsx', 'TtokenChips.module.css', 'install.ts', 'locales.ts']) {
  writeGenerated(`chip composer (${file})`, `packages/client/ui-conversation/src/client/ttoken/${file}`, clientPart(`composer/${file}`))
}
editFile({
  name: 'chip composer (pasang)',
  path: 'packages/client/ui-conversation/src/client/apply.ts',
  pairs: [
    [`import { installStopShortcut } from './stop-shortcut.ts'\n`, `import { installStopShortcut } from './stop-shortcut.ts'\nimport { installTtokenComposer } from './ttoken/install.ts'\n`],
    [
      `  ctx.plugin(todoDockEntry)\n  ctx.plugin(queueDockEntry)\n}\n`,
      `  ctx.plugin(todoDockEntry)\n  ctx.plugin(queueDockEntry)\n  // TTOken Code: working folder and Git branch chips above the draft.\n  installTtokenComposer(ctx)\n}\n`,
    ],
  ],
})
editFile({
  name: 'chip izin (gaya)',
  path: 'packages/client/ui-permission-presets/src/client/PermissionSelect.module.css',
  pairs: [[
    `.trigger:disabled {\n  color: var(--dsw-alias-label-dimmed);\n  cursor: default;\n}\n`,
    `.trigger:disabled {\n  color: var(--dsw-alias-label-dimmed);\n  cursor: default;\n}\n
/* TTOken Code: the permission control is a chip in the composer's option row,
   with the same size and fill as the folder and branch chips. */
.trigger {
  gap: 8px;
  height: 34px;
  padding: 0 8px 0 12px;
  border-radius: 12px;
  background: var(--dsw-specific-selector);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  font-weight: 400;
}

@media (hover: hover) {
  .trigger:hover:not(:disabled) {
    background: var(--dsw-alias-button-ghost-active-hover);
  }
}
`,
  ]],
})

// 24d. Batas langkah per tugas. Penjaga loop repeat-tool-reminder mendapat field
//      volatile `stepLimit` (bawaan 20): langkah dihitung per agent sejak pesan user
//      terakhir; di batas, langkah berikutnya membawa catatan agar model berhenti dan
//      bertanya, dan dua langkah setelahnya langkah ditolak. Composer mengubahnya
//      lewat namespace pengaturan `repeat-tool-reminder`.
editFile({
  name: 'batas langkah (penjaga)',
  path: 'packages/guard/repeat-tool-reminder/src/index.ts',
  pairs: [
    [`import z from '@deepseek-ai/schemastery'\n`, `import z from '@deepseek-ai/schemastery'\nimport type { Volatile } from '@deepseek-ai/cosmokit'\n`],
    [
      `  argumentsPreviewChars?: number\n}\n\nexport const Config: z<Config> = z.object({\n  thresholds: z.array(z.number()).default([3, 5, 8]),\n  include: z.array(z.string()).default([]),\n  exclude: z.array(z.string()).default([]),\n  argumentsPreviewChars: z.number().default(500),\n})\n`,
      `  argumentsPreviewChars?: number
  /**
   * TTOken Code: model steps one task may take, counted from the agent's last
   * user message, before the guard asks the model to stop and ask the user;
   * \`0\` turns the limit off (default 20). Volatile: a change applies from the next step.
   */
  stepLimit?: Volatile<number>
}

/** Raw configuration: {@link Config} with \`stepLimit\` as the plain number cordis.yml and settings write. */
export type ConfigInput = Omit<Config, 'stepLimit'> & { stepLimit?: number }

export const Config: z<ConfigInput, Config> = z.object({
  thresholds: z.array(z.number()).default([3, 5, 8]),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  argumentsPreviewChars: z.number().default(500),
  stepLimit: z.number().step(1).min(0).default(20).volatile(),
}) as z<ConfigInput, Config>
`,
    ],
    [
      `const REMINDER_SOURCE: MessageSource = { kind: 'repeat-tool-reminder' }\n`,
      `const REMINDER_SOURCE: MessageSource = { kind: 'repeat-tool-reminder' }

/** TTOken Code: steps the model may still take after the step-limit notice before the guard rejects the next one. */
const STEP_LIMIT_OVERRUN = 2

/**
 * TTOken Code: the notice added to the first step past the step limit.
 * @param limit - the step limit in force.
 * @returns the logged notice asking the model to stop and ask the user.
 */
function stepLimitNotice(limit: number): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: \`You have used \${limit} steps on this task, the step limit the user set. \`
        + 'Stop calling tools now. Reply with a short summary of what is done and what remains, '
        + 'and ask the user whether to continue.',
    }],
    source: { ...REMINDER_SOURCE, form: 'notice', summary: \`step limit \${limit}\` },
  })
}
`,
    ],
    [
      `    if (messages.some(message => message.source.kind === 'user')) chains.delete(agent)\n    return next()\n  })\n}\n`,
      `    if (messages.some(message => message.source.kind === 'user')) chains.delete(agent)\n    return next()\n  })\n${clientPart('../host/step-limit.ts.part')}}\n`,
    ],
  ],
})
editFile({
  name: 'batas langkah (uji: tipe konfigurasi)',
  path: 'packages/guard/repeat-tool-reminder/tests/repeat-tool-reminder.spec.ts',
  pairs: [[
    `import type { Config } from '@deepseek-ai/dsh-repeat-tool-reminder'\n`,
    `import type { ConfigInput as Config } from '@deepseek-ai/dsh-repeat-tool-reminder'\n`,
  ]],
})
{
  // Uji perilaku batas langkah ditambahkan di akhir suite penjaga.
  const path = 'packages/guard/repeat-tool-reminder/tests/repeat-tool-reminder.spec.ts'
  const spec = clientPart('../host/step-limit.spec.part')
  const text = readFileSync(join(ROOT, path), 'utf8')
  if (text.includes(spec)) report.push('batas langkah (uji): sudah diterapkan')
  else if (CHECK) failures.push(`batas langkah (uji): ${path} belum disunting`)
  else {
    if (!DRY) writeFileSync(join(ROOT, path), text + spec)
    report.push(`batas langkah (uji): ditambahkan${DRY ? ' (rencana)' : ''}`)
  }
}
editFile({
  name: 'batas langkah (README)',
  path: 'packages/guard/repeat-tool-reminder/README.md',
  pairs: [[
    '| `argumentsPreviewChars` | `500` | How many characters of the repeated arguments the detailed reminder shows |\n',
    '| `argumentsPreviewChars` | `500` | How many characters of the repeated arguments the detailed reminder shows |\n'
      + '| `stepLimit` | `20` | TTOken Code: model steps one task may take, counted from the agent\'s last user message; the next step asks the model to stop and ask the user, and two steps later the step is rejected. `0` turns it off. The composer edits it live. |\n',
  ]],
})

// 24e. Papan issue GitHub (Host). Paket forge mendapat tipe issue dan metode
//      opsional `listIssues` di provider; forge-github membacanya lewat satu
//      permintaan GraphQL `gh`; Remote panel forge mendapat `issues(session)`
//      untuk repositori checkout Session. Papannya ada di bundel forge, jadi
//      tampil setelah "Change requests & worktrees" dinyalakan di halaman Plugins.
editFile({
  name: 'issue (tipe forge)',
  path: 'packages/experimental/forge/src/types.ts',
  pairs: [
    [
      `  /** Read the description and labels of a change request. Omission declares that this provider reads no descriptions. */\n`,
      `  /** TTOken Code: read the open and recently closed issues of a repository. Omission declares that this provider reads no issues. */\n  listIssues?(repository: ForgeRepository, signal: AbortSignal): Promise<ForgeIssueList | ForgeFailure>\n  /** Read the description and labels of a change request. Omission declares that this provider reads no descriptions. */\n`,
    ],
    [
      `  /** Human-readable cause. */\n  readonly message: string\n}\n`,
      `  /** Human-readable cause. */\n  readonly message: string\n}\n${forgePart('types.ts.part')}`,
    ],
  ],
})
editFile({
  name: 'issue (registri forge)',
  path: 'packages/experimental/forge/src/index.ts',
  pairs: [
    [
      `  ForgeViewedFiles, ForgeViewedRequest, ForgeViewerFilter, ForgeViewerList, ForgeViewerQuery, ForgeViewerSource, MergeRequest,\n} from './types.ts'\n`,
      `  ForgeViewedFiles, ForgeViewedRequest, ForgeViewerFilter, ForgeViewerList, ForgeViewerQuery, ForgeViewerSource, MergeRequest,\n  ForgeIssueList,\n} from './types.ts'\n`,
    ],
    [
      `        ?? Promise.resolve({ code: 'unsupported', message: 'This provider does not read descriptions' } as const))\n  }\n`,
      `        ?? Promise.resolve({ code: 'unsupported', message: 'This provider does not read descriptions' } as const))\n  }\n
  /**
   * TTOken Code: read the open and recently closed issues of a repository.
   * @param repository - repository served by a registered provider.
   * @param signal - request cancellation.
   * @returns the issues, or why the host did not provide them; \`unsupported\` when the provider reads no issues.
   */
  async listIssues(repository: ForgeRepository, signal: AbortSignal): Promise<ForgeIssueList | ForgeFailure> {
    return await this.invoke(this.registration(repository.forge), signal,
      (provider, operation) => provider.listIssues?.(repository, operation)
        ?? Promise.resolve({ code: 'unsupported', message: 'This provider does not read issues' } as const))
  }
`,
    ],
  ],
})
writeGenerated('issue (pembaca GitHub)', 'packages/experimental/forge-github/src/issues.ts', forgePart('issues.ts'))
writeGenerated('issue (uji pembaca GitHub)', 'packages/experimental/forge-github/tests/issues.spec.ts', forgePart('issues.spec.ts'))
editFile({
  name: 'issue (provider GitHub)',
  path: 'packages/experimental/forge-github/src/provider.ts',
  pairs: [
    [`import { readDescription } from './description.ts'\n`, `import { readDescription } from './description.ts'\nimport { readIssues } from './issues.ts'\n`],
    [
      `  ForgeReviewRequest, ForgeReviewResult, ForgeReviewWrite, ForgeReviewWriteResult, ForgeViewedFiles, ForgeViewedRequest, MergeRequest,\n} from '@deepseek-ai/dsh-experimental-forge'\n`,
      `  ForgeReviewRequest, ForgeReviewResult, ForgeReviewWrite, ForgeReviewWriteResult, ForgeViewedFiles, ForgeViewedRequest, MergeRequest,\n  ForgeIssueList,\n} from '@deepseek-ai/dsh-experimental-forge'\n`,
    ],
    [
      `  async readDescription(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestDescription | ForgeFailure> {\n    const failure = this.hostFailure(ref.repository.host)\n    if (failure !== undefined) return failure\n    return await readDescription(this.graphql, ref, signal)\n  }\n`,
      `  async readDescription(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestDescription | ForgeFailure> {\n    const failure = this.hostFailure(ref.repository.host)\n    if (failure !== undefined) return failure\n    return await readDescription(this.graphql, ref, signal)\n  }\n\n  /**\n   * TTOken Code: read the open and recently closed issues of a repository through GraphQL.\n   * @see readIssues\n   */\n  async listIssues(repository: ForgeRepository, signal: AbortSignal): Promise<ForgeIssueList | ForgeFailure> {\n    const failure = this.hostFailure(repository.host)\n    if (failure !== undefined) return failure\n    return await readIssues(this.graphql, repository, signal)\n  }\n`,
    ],
  ],
})
editFile({
  name: 'issue (tipe panel)',
  path: 'packages/experimental/client-ui-forge/src/types.ts',
  pairs: [
    [
      `  ForgeReadiness, ForgeRepository, ForgeViewerFilter,\n} from '@deepseek-ai/dsh-experimental-forge/types'\n`,
      `  ForgeReadiness, ForgeRepository, ForgeViewerFilter, ForgeIssueList,\n} from '@deepseek-ai/dsh-experimental-forge/types'\n`,
    ],
    [
      `/** Git facts for the checkout that contains the Session's current directory. */\n`,
      `/** TTOken Code: the issues board of a Session's repository. */\nexport interface ForgeIssueBoard extends ForgeIssueList {\n  /** Repository as \`owner/name\`. */\n  readonly repository: string\n  /** Code host of the repository, such as \`github.com\`. */\n  readonly host: string\n}\n\n/** Git facts for the checkout that contains the Session's current directory. */\n`,
    ],
    [
      `    /** No registered provider serves the change request URL. */\n    'forgePanel/unrecognized-url': Record<string, never>\n`,
      `    /** No registered provider serves the change request URL. */\n    'forgePanel/unrecognized-url': Record<string, never>\n    /** TTOken Code: no remote of the checkout names a repository a code host provider serves. */\n    'forgePanel/issues-unavailable': Record<string, never>\n    /** TTOken Code: the code host did not provide the repository's issues; the message says why. */\n    'forgePanel/issues-failed': Record<string, never>\n`,
    ],
  ],
})
editFile({
  name: 'issue (Remote panel)',
  path: 'packages/experimental/client-ui-forge/src/index.ts',
  pairs: [
    [`  Config, ForgeBaseBranches, ForgeChangeRequestDiff,`, `  Config, ForgeBaseBranches, ForgeIssueBoard, ForgeChangeRequestDiff,`],
    [
      `    this.home.forgeSession.track(session, url)\n  }\n`,
      `    this.home.forgeSession.track(session, url)\n  }\n
  /**
   * TTOken Code: read the issues board of the Session's repository: its open and recently closed issues with the pull
   * requests that close them, from the first remote, in recognition order, that names a repository a provider serves.
   * @param session - Session whose checkout names the repository.
   * @param signal - request cancellation.
   * @returns the repository with its issues.
   * @throws \`forgePanel/not-a-checkout\` outside a checkout; \`forgePanel/issues-unavailable\` when no remote names a served
   * repository; \`forgePanel/issues-failed\` when the code host did not provide the issues.
   */
  @Remote
  async issues(session: Session, signal: AbortSignal): Promise<ForgeIssueBoard> {
    signal.throwIfAborted()
    const inspection = await this.checkoutOf(session, signal)
    for (const remote of remoteOrder(inspection.upstream, inspection.remotes)) {
      for (const url of remote.urls) {
        const repository = this.home.forge.repositoryFromRemote(url)
        if (repository === undefined) continue
        const list = await this.home.forge.listIssues(repository, signal)
        if ('code' in list) throw new RemoteError('forgePanel/issues-failed', list.message, {})
        return { ...list, repository: \`\${repository.owner}/\${repository.name}\`, host: repository.host }
      }
    }
    throw new RemoteError('forgePanel/issues-unavailable', 'No remote of the checkout names a repository on a supported code host', {})
  }
`,
    ],
  ],
})

// 24f. Papan issue GitHub (Client). Tab tampilan percakapan "Issues" di samping
//      Chat: empat kolom gelap (To do, Agent working, In review, Done), panel
//      detail yang membuka sesi agen baru di cabang sendiri, dan sesi perbaikan
//      untuk pull request yang cek-nya gagal.
for (const file of ['locales.ts', 'agents.ts', 'IssuesBoard.tsx', 'IssuesBoard.module.css', 'install.ts']) {
  writeGenerated(`papan issue (${file})`, `packages/experimental/client-ui-forge/src/client/ttoken-issues/${file}`, forgePart(`client/${file}`))
}
editFile({
  name: 'papan issue (pemasangan)',
  path: 'packages/experimental/client-ui-forge/src/client/mount.ts',
  pairs: [
    [
      `import { WorktreeToggle, type WorktreeToggleInjected } from './WorktreeToggle.tsx'\n`,
      `import { WorktreeToggle, type WorktreeToggleInjected } from './WorktreeToggle.tsx'\nimport { installTtokenIssues } from './ttoken-issues/install.ts'\n`,
    ],
    [
      `    name: 'plugins.row.config', key: WORKTREE_ROW_KEY, locale: NS, inject: () => worktreeSettings.inject(),\n  }, WorktreeSettings))\n}\n`,
      `    name: 'plugins.row.config', key: WORKTREE_ROW_KEY, locale: NS, inject: () => worktreeSettings.inject(),\n  }, WorktreeSettings))\n  installTtokenIssues(ctx, openLink)\n}\n`,
    ],
  ],
})

// 27. Panel Perangkat Android (paket baru `packages/experimental/android-device`).
//      Tab "Device" di sidebar kanan: daftar perangkat dari adb di komputer ini,
//      layar perangkat (klik = tap, seret = swipe), tombol Back/Home/Recent,
//      ketik teks, jendela cermin scrcpy, dan catatan di draf pesan agar agen
//      memakai perangkat lewat adb. Dimuat oleh bundel web-app, jadi ada di
//      desktop tanpa harus dinyalakan. Lockfile memuat importer paket ini
//      (dihasilkan `pnpm install --lockfile-only`).
const DEVICE_DIR = 'packages/experimental/android-device'
for (const file of [
  'package.json', 'README.md', 'tsconfig.json', 'tsconfig.host.json', 'tsconfig.client.json', 'tsdown.config.ts',
  'locale/de.json', 'locale/en.json', 'locale/es.json', 'locale/fr.json', 'locale/ja.json', 'locale/pt.json', 'locale/ru.json',
  'locale/zh.json', 'src/index.ts', 'src/adb.ts', 'src/types.ts', 'src/css-modules.d.ts', 'src/client/index.ts',
  'src/client/mount.ts', 'src/client/DevicePanel.tsx', 'src/client/DevicePanel.module.css', 'src/client/locales.ts',
  'tests/adb.spec.ts',
]) {
  writeGenerated(`perangkat (${file})`, `${DEVICE_DIR}/${file}`, devicePart(file))
}
editFile({
  name: 'perangkat (alias path)',
  path: 'tsconfig.base.json',
  pairs: [[
    `      "@deepseek-ai/dsh-experimental-client-ui-forge/client": ["./packages/experimental/client-ui-forge/src/client/index.ts"],\n`,
    `      "@deepseek-ai/dsh-experimental-client-ui-forge/client": ["./packages/experimental/client-ui-forge/src/client/index.ts"],\n`
      + `      "@deepseek-ai/dsh-experimental-android-device": ["./packages/experimental/android-device/src/index.ts"],\n`
      + `      "@deepseek-ai/dsh-experimental-android-device/types": ["./packages/experimental/android-device/src/types.ts"],\n`
      + `      "@deepseek-ai/dsh-experimental-android-device/client": ["./packages/experimental/android-device/src/client/index.ts"],\n`,
  ]],
})
editFile({
  name: 'perangkat (agregat Host)',
  path: 'tsconfig.host.json',
  pairs: [[
    `    { "path": "./packages/experimental/client-ui-forge/tsconfig.host.json" },\n`,
    `    { "path": "./packages/experimental/client-ui-forge/tsconfig.host.json" },\n    { "path": "./packages/experimental/android-device/tsconfig.host.json" },\n`,
  ]],
})
editFile({
  name: 'perangkat (agregat Client)',
  path: 'tsconfig.client.json',
  pairs: [[
    `    { "path": "./packages/experimental/client-ui-forge/tsconfig.client.json" },\n`,
    `    { "path": "./packages/experimental/client-ui-forge/tsconfig.client.json" },\n    { "path": "./packages/experimental/android-device/tsconfig.client.json" },\n`,
  ]],
})
editFile({
  name: 'perangkat (bundel web-app)',
  path: 'packages/bundle/web-app/package.json',
  pairs: [[
    `    "@deepseek-ai/dsh-client-ui-sidebar-terminal": "workspace:*",\n`,
    `    "@deepseek-ai/dsh-client-ui-sidebar-terminal": "workspace:*",\n    "@deepseek-ai/dsh-experimental-android-device": "workspace:*",\n`,
  ]],
})
editFile({
  name: 'perangkat (profil web-app)',
  path: 'packages/bundle/web-app/cordis.patch.yml',
  pairs: [[
    `    - id: ui-sidebar-terminal\n      name: '@deepseek-ai/dsh-client-ui-sidebar-terminal'\n`,
    `    - id: ui-sidebar-terminal\n      name: '@deepseek-ai/dsh-client-ui-sidebar-terminal'\n`
      + `    # TTOken Code: the right Sidebar's Android device tab, over adb on the Host.\n`
      + `    - id: android-device\n      name: '@deepseek-ai/dsh-experimental-android-device'\n`,
  ]],
})
editFile({
  name: 'perangkat (lockfile)',
  path: 'pnpm-lock.yaml',
  pairs: DEVICE_LOCK_PAIRS,
})

// 25. Diff: baris yang ditambah blok hijau, yang dihapus blok merah. Teks kode
//     tetap warna teks utama supaya terbaca; tanda + dan - memakai warna blok.
editFile({
  name: 'diff (warna baris)',
  path: 'packages/client/ui-primitives/src/DiffBlock.module.css',
  pairs: [
    [`.del::before {\n  content: '- ';\n}\n`, `.del::before {\n  content: '- ';\n  color: var(--dsw-alias-file-diff-deleted-marker);\n}\n`],
    [`.del {\n  color: var(--dsw-alias-state-error-primary);\n`, `.del {\n  color: var(--dsw-alias-label-primary);\n`],
    [`.add::before {\n  content: '+ ';\n}\n`, `.add::before {\n  content: '+ ';\n  color: var(--dsw-alias-file-diff-added-marker);\n}\n`],
    [`.add {\n  color: var(--dsw-alias-state-success-primary);\n`, `.add {\n  color: var(--dsw-alias-label-primary);\n`],
  ],
})

// 26. Warna bilah judul Windows sebelum halaman selesai dimuat mengikuti palet TTOken.
editFile({
  name: 'bilah judul (warna awal)',
  path: 'apps/desktop/src/main.ts',
  pairs: [[
    `  return nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f9fafb'\n`,
    `  return nativeTheme.shouldUseDarkColors ? '#111111' : '#f3f2ee'\n`,
  ]],
})

for (const line of report) console.log(line)
if (failures.length > 0) {
  for (const line of failures) console.error(`GAGAL  ${line}`)
  process.exit(1)
}
