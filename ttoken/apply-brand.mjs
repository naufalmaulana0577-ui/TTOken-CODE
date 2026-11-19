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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

/**
 * Sisipkan satu kunci baru ke setiap kamus bahasa dalam satu file, tepat setelah baris kunci jangkar.
 *
 * Nilai diberikan berurutan sesuai kemunculan jangkar di file. Kunci yang sudah ada di setiap
 * kamus berarti aturan sudah diterapkan; jumlah lain berarti upstream atau aturan berubah.
 * Gaya kunci (bertanda kutip atau tidak) mengikuti baris jangkar.
 * @param {{ name: string, path: string, after: string, key: string, values: string[] }} rule Aturan penyisipan.
 * @returns {void}
 */
function insertLocaleKey(rule) {
  const absolute = join(ROOT, rule.path)
  const original = readFileSync(absolute, 'utf8')
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const existing = original.match(new RegExp(`^\\s*(?:'${escape(rule.key)}'|${escape(rule.key)})\\s*:`, 'gm'))?.length ?? 0
  if (existing === rule.values.length) {
    report.push(`${rule.name}: sudah diterapkan`)
    return
  }
  const anchor = new RegExp(`^(\\s*)('${escape(rule.after)}'|${escape(rule.after)})(\\s*:.*,)$`, 'gm')
  const anchors = original.match(anchor)?.length ?? 0
  if (existing !== 0 || anchors !== rule.values.length) {
    failures.push(`${rule.name}: ${rule.path} memuat ${existing} kunci ${rule.key} dan ${anchors} jangkar ${rule.after}, seharusnya 0 dan ${rule.values.length}; perbarui aturannya`)
    return
  }
  if (CHECK) {
    failures.push(`${rule.name}: ${rule.path} belum disunting`)
    return
  }
  let index = 0
  const next = original.replace(anchor, (line, indent, key) => {
    const value = rule.values[index++]
    const literal = value.includes("'") ? JSON.stringify(value) : `'${value}'`
    const name = key.startsWith("'") ? `'${rule.key}'` : rule.key
    return `${line}\n${indent}${name}: ${literal},`
  })
  if (!DRY) writeFileSync(absolute, next)
  report.push(`${rule.name}: ${rule.values.length} kunci disisipkan${DRY ? ' (rencana)' : ''}`)
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
editFile({
  name: 'penerbit (uji metadata installer)',
  path: 'apps/desktop/tests/installer-packaging.spec.ts',
  pairs: [[`expect(appInfo.companyName).toBe('${upstream.publisher}')`, `expect(appInfo.companyName).toBe('${brand.publisher}')`]],
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

// 16. Layar sambutan dari desain terang: kertas, mark tinta di tengah, nama produk
//     dengan Archivo, tagline TTOken, tombol penuh, dan satu baris atribusi di bawah.
//     Halaman API key memakai mark kecil yang sama, bukan gambar merek upstream.
const markPaths = fill => `<path d="${MARK_BODY}" fill="${fill}" /><path d="${MARK_BAR}" fill="${fill}" />`
editFile({
  name: 'sambutan-tata-letak',
  path: 'apps/desktop/src/client/WelcomePage.tsx',
  pairs: [
    [
      `<img className="brand" src="assets/welcome-brand.svg" alt={m.welcomeBrand} width="472" height="40" />`,
      `{page === 'entry' ? null : <svg className="brand" viewBox="0 0 56 48" aria-hidden="true">${markPaths('currentColor')}</svg>}`,
    ],
    [
      `<h1 id="welcome-heading"><span>{m.welcomeTaglineBefore}</span><em>{m.welcomeTaglineBrand}</em><span>{m.welcomeTaglineAfter}</span></h1>`,
      `<svg className="mark" viewBox="0 0 56 48" aria-hidden="true">${markPaths('currentColor')}</svg>\n        <h1 id="welcome-heading">{m.welcomeBrand}</h1>`,
    ],
    [`<p id="welcome-description">{m.welcomeDescription}</p>`, `<p id="welcome-description">{m.welcomeTagline}</p>`],
    [
      `void start() }}>{m.welcomeSignIn}</button>`,
      `void start() }}><svg className="button-mark" viewBox="0 0 56 48" aria-hidden="true">${markPaths(KUNYIT)}</svg>{m.welcomeSignIn}</button>`,
    ],
    [
      `navigate('key') }}>{m.welcomeApiKey}</button>\n      </div>\n      <div id="key-actions"`,
      `navigate('key') }}>{m.welcomeApiKey}</button>\n        <p className="new-account">{m.welcomeNewAccount.split('ttoken.dev').flatMap((part, index) => index === 0 ? [part] : [<strong key={index}>ttoken.dev</strong>, part])}</p>\n      </div>\n      <div id="key-actions"`,
    ],
    [
      `}}>{m.welcomeKeyBack}</button>\n      </div>\n    </main>`,
      `}}>{m.welcomeKeyBack}</button>\n      </div>\n      <p className="attribution">{m.welcomeDescription}</p>\n    </main>`,
    ],
  ],
})
editFile({
  name: 'sambutan-gaya',
  path: 'apps/desktop/renderer/welcome.css',
  pairs: [[
    `.auth-waiting .copy-link:disabled { cursor: default; }\n`,
    `.auth-waiting .copy-link:disabled { cursor: default; }\n\n${readFileSync(join(ROOT, 'ttoken', 'renderer', 'welcome.css.part'), 'utf8')}`,
  ]],
})
editFile({
  name: 'sambutan (test)',
  path: 'apps/desktop/tests/welcome-renderer.client.spec.tsx',
  pairs: [
    [
      `      document.title, document.querySelector('img')!.alt, document.getElementById(heading)!.textContent,\n`,
      `      document.title, document.getElementById(heading)!.textContent,\n`,
    ],
    [
      `    expect(view.document.querySelector('img')!.getAttribute('src')).toBe('assets/welcome-brand.svg')\n`,
      `    expect(view.document.querySelector('svg.mark')).not.toBeNull()\n`,
    ],
  ],
})
copyAssets('sambutan (teks yang diharapkan)', readdirSync(join(ROOT, 'ttoken', 'desktop', 'welcome-expected'))
  .map(file => [`ttoken/desktop/welcome-expected/${file}`, `apps/desktop/tests/expected/welcome/${file}`]))
setQuotedValues({
  name: 'sambutan-atribusi',
  paths: ['apps/desktop/src/locale.ts'],
  pattern: /(welcomeDescription: )('[^'\n]*'|"[^"\n]*")/g,
  value: ATTRIBUTION,
  expected: 8,
})
// Urutan kamus desktop: en, zh, ja, es, fr, de, ru, pt.
insertLocaleKey({
  name: 'sambutan-tagline',
  path: 'apps/desktop/src/locale.ts',
  after: 'welcomeDescription',
  key: 'welcomeTagline',
  values: [
    'The coding agent you pay for per token.', '按 token 付费的编程智能体。', 'トークン単位で支払うコーディングエージェント。',
    'El agente de programación que pagas por token.', 'L’agent de code que vous payez au token.', 'Der Coding-Agent, den Sie pro Token bezahlen.',
    'Агент для программирования с оплатой за токены.', 'O agente de programação que você paga por token.',
  ],
})
insertLocaleKey({
  name: 'sambutan-akun-baru',
  path: 'apps/desktop/src/locale.ts',
  after: 'welcomeTagline',
  key: 'welcomeNewAccount',
  values: [
    'New to TTOken? Create an account at ttoken.dev', '还没有 TTOken 账号？在 ttoken.dev 注册', 'TTOken は初めてですか？ttoken.dev でアカウントを作成',
    '¿Nuevo en TTOken? Crea una cuenta en ttoken.dev', 'Nouveau sur TTOken ? Créez un compte sur ttoken.dev', 'Neu bei TTOken? Erstellen Sie ein Konto auf ttoken.dev',
    'Впервые в TTOken? Создайте аккаунт на ttoken.dev', 'Novo no TTOken? Crie uma conta em ttoken.dev',
  ],
})
setLocaleValues({
  name: 'sambutan-tombol-key',
  path: 'apps/desktop/src/locale.ts',
  key: 'welcomeApiKey',
  values: ['Use an API key', '添加 API Key', 'APIキーを追加', 'Agregar clave API', 'Ajouter une clé API', 'API-Schlüssel hinzufügen', 'Добавить ключ API', 'Adicionar chave API'],
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

/**
 * Baca berkas sumber aplikasi desktop dari `ttoken/desktop/`.
 * @param path Path relatif terhadap `ttoken/desktop/`.
 * @returns Isi berkas.
 */
function desktopPart(path) {
  return readFileSync(join(ROOT, 'ttoken', 'desktop', path), 'utf8')
}

/**
 * Baca berkas sumber installer dari `ttoken/installer/`.
 * @param path Path relatif terhadap `ttoken/installer/`.
 * @returns Isi berkas.
 */
function installerPart(path) {
  return readFileSync(join(ROOT, 'ttoken', 'installer', path), 'utf8')
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

// 23. Fon desain sistem TTOken Marketing: Inter untuk teks, Archivo untuk judul dan
//     nama produk (lewat --dsw-font-family-brand, lebar 125% di tempat pemakaiannya),
//     IBM Plex Mono untuk kode, label, dan path. Semuanya ikut dibundel (lisensi SIL OFL)
//     supaya Windows yang tidak memasangnya tampil sama.
const FONT_FILES = [
  'inter-latin-wght.woff2', 'inter-latin-ext-wght.woff2',
  'archivo-latin-wdth.woff2', 'archivo-latin-ext-wdth.woff2',
  ...['400', '500', '600'].flatMap(weight => [`ibm-plex-mono-latin-${weight}.woff2`, `ibm-plex-mono-latin-ext-${weight}.woff2`]),
  'Inter-OFL.txt', 'Archivo-OFL.txt', 'IBMPlexMono-OFL.txt',
]
copyAssets('fon (berkas)', FONT_FILES.map(file => [`ttoken/fonts/${file}`, `packages/client/ui-theme/src/styles/${file}`]))
const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'
const LATIN_EXT = 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF'
const fontFace = (family, weights, file, range, stretch) => `
@font-face {
  font-family: '${family}';
  font-style: normal;
  font-weight: ${weights};${stretch === undefined ? '' : `\n  font-stretch: ${stretch};`}
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
      + `\n/* TTOken Code text, heading, and code fonts; SIL Open Font License in Inter-OFL.txt, Archivo-OFL.txt, and IBMPlexMono-OFL.txt. */`
      + fontFace('Inter', '100 900', 'inter-latin-wght.woff2', LATIN)
      + fontFace('Inter', '100 900', 'inter-latin-ext-wght.woff2', LATIN_EXT)
      + fontFace('Archivo', '100 900', 'archivo-latin-wdth.woff2', LATIN, '62% 125%')
      + fontFace('Archivo', '100 900', 'archivo-latin-ext-wdth.woff2', LATIN_EXT, '62% 125%')
      + ['400', '500', '600'].map(weight => fontFace('IBM Plex Mono', weight, `ibm-plex-mono-latin-${weight}.woff2`, LATIN)
        + fontFace('IBM Plex Mono', weight, `ibm-plex-mono-latin-ext-${weight}.woff2`, LATIN_EXT)).join(''),
  ]],
})
editFile({
  name: 'fon (tumpukan bawaan)',
  path: 'packages/client/ui-theme/src/styles/base.css',
  pairs: [
    [`  --dsh-font-family-text-default: -apple-system,`, `  --dsh-font-family-text-default: 'Inter', -apple-system,`],
    [`  --dsw-font-family-brand: 'Montserrat', var(--dsh-font-family-text-default);`, `  --dsw-font-family-brand: 'Archivo', var(--dsh-font-family-text-default);`],
    [`  --dsh-font-family-code-default: 'SF Mono', 'JetBrains Mono', 'Fira Code',`, `  --dsh-font-family-code-default: 'IBM Plex Mono', 'SF Mono', 'JetBrains Mono', 'Fira Code',`],
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

// 24. Composer dari desain terang: kartu putih datar bergaris tegas, dan satu baris
//     kontrol di dalam kartu: tombol perintah, mode Agent/Plan, izin, lalu model,
//     batas langkah, dan tombol kirim bulat hitam. Logika InputBar upstream tidak
//     diubah; hanya urutan slot dan gayanya.
editFile({
  name: 'composer (urutan)',
  path: 'packages/client/ui-conversation/src/client/skeleton/InputBar.tsx',
  pairs: [
    [
      `              {sessionId === undefined ? null : renderSlot('conversation.input.permission', { locked })}\n              {sessionId === undefined ? null : renderSlot('conversation.input.plan', { locked })}\n`,
      `              {sessionId === undefined ? null : renderSlot('conversation.input.plan', { locked })}\n              {sessionId === undefined ? null : renderSlot('conversation.input.permission', { locked })}\n`,
    ],
    [
      `              {input === undefined || sessionId === undefined\n                ? null\n                : renderSlot('conversation.input.right', {})}\n              {sessionId === undefined ? null : renderSlot('conversation.input.model', { locked: modelSeatLocked })}\n`,
      `              {sessionId === undefined ? null : renderSlot('conversation.input.model', { locked: modelSeatLocked })}\n              {input === undefined || sessionId === undefined\n                ? null\n                : renderSlot('conversation.input.right', {})}\n`,
    ],
  ],
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

replaceTokens({
  name: 'composer (uji placeholder)',
  scopes: ['packages/client/ui-conversation/tests/input-bar.client.spec.tsx'],
  pairs: [['发消息或创建任务, / 调用指令, @ 文件或对话', '让 Code 解答，或描述一项修改']],
})
editFile({
  name: 'composer (uji urutan)',
  path: 'packages/client/ui-conversation/tests/input-bar.client.spec.tsx',
  pairs: [[
    `      'conversation.input.permission', 'conversation.input.plan', 'conversation.input.left',\n      'conversation.input.right', 'conversation.input.model', 'conversation.input.activity',\n`,
    `      'conversation.input.plan', 'conversation.input.permission', 'conversation.input.left',\n      'conversation.input.model', 'conversation.input.right', 'conversation.input.activity',\n`,
  ]],
})

// 24b. Mode di composer: tombol bersegmen "Agent" dan "Plan". Upstream hanya
//      menampilkan chip saat mode rencana aktif dan masuknya lewat /plan; di sini
//      kedua mode dipilih dari satu kontrol, memakai perintah /plan dan /plan off yang sama.
editFile({
  name: 'mode (impor)',
  path: 'packages/client/ui-plan/src/client/PlanModeControl.tsx',
  pairs: [
    [
      `import { IconCloseCircleFillRegular, IconPlanOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'\n`,
      `import { IconPlanOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'\n`,
    ],
    [
      ` * Plan-mode status over the host-computed \`plan\` projection. The chip renders\n * only while the effective target is plan mode (\`pending ? !active : active\`\n * — a folded host value, not client optimism) and executes /plan off.\n`,
      ` * Agent and Plan buttons over the host-computed \`plan\` projection: the pressed\n * button is the effective target (\`pending ? !active : active\`, a folded host\n * value, not client optimism), and pressing the other executes /plan or /plan off.\n`,
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
      ` * PlanChip over the \`plan\` projection: nothing renders while the capability\n * is absent; otherwise the pressed button is the effective target, and pressing\n * the other executes /plan or /plan off, reporting failures in place until the\n * projection confirms the change.\n`,
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
  zh: ['智能体', '计划', '读取、修改并运行命令', '先写计划，不做修改', '模式：{name}', '进入计划模式失败'],
  en: ['Agent', 'Plan', 'Reads, edits and runs commands', 'Writes a plan first, changes nothing', 'Mode: {name}', 'Failed to enter plan mode'],
  ja: ['エージェント', '計画', '読み取り、編集、コマンド実行', '先に計画を書き、変更はしない', 'モード: {name}', '計画モードに入れませんでした'],
  es: ['Agente', 'Plan', 'Lee, edita y ejecuta comandos', 'Primero escribe un plan, no cambia nada', 'Modo: {name}', 'No se pudo entrar en el modo de plan'],
  fr: ['Agent', 'Plan', 'Lit, modifie et exécute des commandes', 'Rédige d’abord un plan, ne modifie rien', 'Mode : {name}', 'Impossible d’activer le mode Plan'],
  de: ['Agent', 'Plan', 'Liest, bearbeitet und führt Befehle aus', 'Schreibt zuerst einen Plan, ändert nichts', 'Modus: {name}', 'Der Planmodus konnte nicht gestartet werden'],
  ru: ['Агент', 'План', 'Читает, изменяет и выполняет команды', 'Сначала пишет план, ничего не меняет', 'Режим: {name}', 'Не удалось включить режим планирования.'],
  pt: ['Agente', 'Plano', 'Lê, edita e executa comandos', 'Escreve um plano primeiro, não altera nada', 'Modo: {name}', 'Falha ao entrar no modo de plano'],
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

// 24c. Chip folder dan cabang Git di samping judul sesi. Cabang dibaca dari berkas
//      HEAD lewat Remote workspaceFiles yang sudah ada, jadi tidak ada layanan Host baru.
for (const file of ['TtokenChips.tsx', 'TtokenChips.module.css', 'TaskStatus.tsx', 'TaskStatus.module.css', 'install.ts', 'locales.ts']) {
  writeGenerated(`chip composer (${file})`, `packages/client/ui-conversation/src/client/ttoken/${file}`, clientPart(`composer/${file}`))
}
editFile({
  name: 'chip composer (pasang)',
  path: 'packages/client/ui-conversation/src/client/apply.ts',
  pairs: [
    [`import { installStopShortcut } from './stop-shortcut.ts'\n`, `import { installStopShortcut } from './stop-shortcut.ts'\nimport { installTtokenComposer } from './ttoken/install.ts'\n`],
    [
      `  ctx.plugin(todoDockEntry)\n  ctx.plugin(queueDockEntry)\n}\n`,
      `  ctx.plugin(todoDockEntry)\n  ctx.plugin(queueDockEntry)\n  // TTOken Code: working folder and Git branch beside the Session title, step limit in the composer row, task status above it.\n  installTtokenComposer(ctx)\n}\n`,
    ],
  ],
})
editFile({
  name: 'chip izin (gaya)',
  path: 'packages/client/ui-permission-presets/src/client/PermissionSelect.module.css',
  pairs: [[
    `.trigger:disabled {\n  color: var(--dsw-alias-label-dimmed);\n  cursor: default;\n}\n`,
    `.trigger:disabled {\n  color: var(--dsw-alias-label-dimmed);\n  cursor: default;\n}\n
/* TTOken Code: the permission control is a chip in the composer's bottom row,
   white with a hairline border like the design's toggles. */
.trigger {
  gap: 8px;
  height: 36px;
  padding: 0 8px 0 12px;
  box-sizing: border-box;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  font-weight: 400;
}

@media (hover: hover) {
  .trigger:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover-solid);
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

// 28. Mode GitHub menyala untuk profil baru. Template profil `web` (desktop
//      dan Web) ikut memuat bundel "Change requests & worktrees", jadi tab
//      Issues, halaman Code review, dan worktree langsung ada. Bundel itu tetap
//      opsional: bisa dimatikan di halaman Plugins, dan profil yang sudah ada
//      tidak diubah. Gerbang isolasi produk default mencatat paket eksperimental
//      yang sengaja dikirim menyala: bundel ini beserta paketnya, dan panel
//      Perangkat dari aturan 27.
editFile({
  name: 'mode GitHub (template web)',
  path: 'packages/util/official-bundles/src/bundles.ts',
  pairs: [
    [
      `  web: {\n    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],\n  },\n`,
      `  web: {\n    // TTOken Code: new web profiles start with the forge bundle (issues board, change requests, worktrees) on.\n`
        + `    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-forge-bundle'],\n  },\n`,
    ],
    [
      ` * [admission](../../../../.agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md)).\n */\nexport const OPTIONAL_BUNDLES`,
      ` * [admission](../../../../.agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md)).\n`
        + ` * TTOken Code: the \`web\` template also selects \`@deepseek-ai/dsh-experimental-forge-bundle\`, so a new \`web\`\n`
        + ` * profile lists it switched on.\n */\nexport const OPTIONAL_BUNDLES`,
    ],
  ],
})
editFile({
  name: 'mode GitHub (uji template)',
  path: 'packages/util/official-bundles/tests/official-bundles.spec.ts',
  pairs: [[
    `      web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] },\n`,
    `      web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-forge-bundle'] },\n`,
  ]],
})
editFile({
  name: 'mode GitHub (uji bundel opsional)',
  path: 'scripts/optional-bundles.spec.ts',
  pairs: [[
    `    const name = '@deepseek-ai/dsh-experimental-forge-bundle'\n    expect(OPTIONAL_BUNDLES).toContain(name)\n`
      + `    for (const template of Object.values(PROFILE_TEMPLATES)) expect(template.bundles).not.toContain(name)\n`,
    `    const name = '@deepseek-ai/dsh-experimental-forge-bundle'\n    expect(OPTIONAL_BUNDLES).toContain(name)\n`
      + `    // TTOken Code: the web template selects it; every other template leaves it to the person.\n`
      + `    for (const [profile, template] of Object.entries(PROFILE_TEMPLATES)) {\n`
      + `      expect(template.bundles.includes(name)).toBe(profile === 'web')\n    }\n`,
  ]],
})
editFile({
  name: 'mode GitHub (uji rescue)',
  path: 'apps/cli/tests/built-bin.e2e.ts',
  pairs: [[
    `      expect(manifest.dsh.profile).toEqual({\n        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],\n      })\n`,
    `      expect(manifest.dsh.profile).toEqual({\n`
      + `        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-forge-bundle'],\n      })\n`,
  ]],
})
editFile({
  name: 'mode GitHub (roster uji klien)',
  path: 'packages/test-support/client-runtime/src/assembly/bundle-roster.ts',
  pairs: [[
    ` * The \`web\` profile's bundle layers, in the order \`dsh --profile web\` applies them\n`
      + ` * (\`PROFILE_TEMPLATES.web\` in \`@deepseek-ai/dsh-official-bundles\`).\n */\n`,
    ` * The \`web\` profile's base bundle layers, in the order \`dsh --profile web\` applies them\n`
      + ` * (\`PROFILE_TEMPLATES.web\` in \`@deepseek-ai/dsh-official-bundles\`). The TTOken Code template also selects the\n`
      + ` * forge bundle, which this roster leaves out so client tests compose the base product.\n */\n`,
  ]],
})
editFile({
  name: 'mode GitHub (uji roster profil)',
  path: 'packages/experimental/webworker-packer/tests/profile-image.spec.ts',
  pairs: [[
    `    expect(bundles).toEqual([...PROFILE_TEMPLATES.web!.bundles, ...OPTIONAL_BUNDLES])\n`,
    `    expect(bundles).toEqual([...new Set([...PROFILE_TEMPLATES.web!.bundles, ...OPTIONAL_BUNDLES])])\n`,
  ]],
})
editFile({
  name: 'mode GitHub (gerbang isolasi produk)',
  path: 'scripts/verify-default-product-isolation.ts',
  pairs: [
    [
      ` * The one declared exception is a bundle the launcher names in \`OPTIONAL_BUNDLES\`: shipped for the person to\n`
        + ` * switch on, selected by no shipped template, its own dependency graph outside the default product's.\n */\n`,
      ` * One declared exception is a bundle the launcher names in \`OPTIONAL_BUNDLES\`: shipped for the person to\n`
        + ` * switch on, selected by no shipped template, its own dependency graph outside the default product's. The other\n`
        + ` * is the TTOken Code list in \`ttoken/default-experimental.json\`: experimental packages its product ships switched on.\n */\n`,
    ],
    [
      `const EXTERNAL_KIT_PACKAGES = new Set(['@deepseek-ai/libreoffice-kit'])\n`,
      `const EXTERNAL_KIT_PACKAGES = new Set(['@deepseek-ai/libreoffice-kit'])\n`
        + `// Experimental packages TTOken Code ships switched on: the Android device panel in the Web composition, and the forge\n`
        + `// bundle with the packages it composes, which the \`web\` template selects (ttoken/README.md, rules 27 and 28).\n`
        + `const TTOKEN_DEFAULT_EXPERIMENTAL_FILE = 'ttoken/default-experimental.json'\n`,
    ],
    [
      `export function verifyDefaultProductIsolation(root: string): ProductIsolationResult {\n  const failures: string[] = []\n`,
      `export function verifyDefaultProductIsolation(root: string): ProductIsolationResult {\n  const failures: string[] = []\n`
        + `  const admitted = ttokenDefaultExperimental(root)\n`,
    ],
    [
      `    || display(pkg.directory).startsWith('packages/experimental/')\n  const add = `,
      `    || display(pkg.directory).startsWith('packages/experimental/')\n`
        + `  for (const name of admitted) {\n    const pkg = packages.get(name)\n    if (pkg === undefined || !isExperimental(pkg)) {\n`
        + `      failures.push(\`\${TTOKEN_DEFAULT_EXPERIMENTAL_FILE}: \${name} is not an experimental workspace package\`)\n    }\n  }\n`
        + `  const add = `,
    ],
    [
      `    if (isExperimental(pkg)) {\n      failures.push(\`\${origin} -> \${pkg.manifest.name}: default product must not include experimental packages\`)\n`,
      `    if (isExperimental(pkg)) {\n      if (admitted.has(pkg.manifest.name)) return\n`
        + `      failures.push(\`\${origin} -> \${pkg.manifest.name}: default product must not include experimental packages\`)\n`,
    ],
    [
      `    if (isExperimentalPackageName(packageName)) {\n`
        + `      failures.push(\`\${origin} -> \${name}: default product must not include experimental packages\`)\n      return\n    }\n`,
      `    if (isExperimentalPackageName(packageName)) {\n      if (!admitted.has(packageName)) {\n`
        + `        failures.push(\`\${origin} -> \${name}: default product must not include experimental packages\`)\n      }\n`
        + `      return\n    }\n`,
    ],
    [
      `      if (optionalBundles.has(name)) failures.push(\`\${PROFILE_SOURCE}: optional bundle \${name} must not be a default bundle\`)\n`,
      `      if (optionalBundles.has(name) && !admitted.has(name)) {\n`
        + `        failures.push(\`\${PROFILE_SOURCE}: optional bundle \${name} must not be a default bundle\`)\n      }\n`,
    ],
    [
      `function barePackageName(specifier: string): string {\n`,
      `/**\n * Read the experimental packages TTOken Code ships switched on.\n`
        + ` * @param root - repository root; a root without the list admits none.\n`
        + ` * @returns the admitted package names.\n * @throws when the list is not a JSON array of strings.\n */\n`
        + `function ttokenDefaultExperimental(root: string): ReadonlySet<string> {\n`
        + `  const path = resolve(root, TTOKEN_DEFAULT_EXPERIMENTAL_FILE)\n`
        + `  if (!existsSync(path)) return new Set()\n`
        + `  const names: unknown = JSON.parse(readFileSync(path, 'utf8'))\n`
        + `  if (!Array.isArray(names) || !names.every((name): name is string => typeof name === 'string')) {\n`
        + `    throw new Error(\`\${TTOKEN_DEFAULT_EXPERIMENTAL_FILE}: expected a JSON array of package names\`)\n  }\n`
        + `  return new Set(names)\n}\n\n`
        + `function barePackageName(specifier: string): string {\n`,
    ],
  ],
})

// 29. Installer menawarkan menutup TTOken Code yang masih berjalan, bukan
//      hanya menyuruh keluar dari system tray. OK: installer menjalankan
//      aplikasi dengan --quit-for-installer (build baru keluar rapi tanpa
//      konfirmasi kedua), menunggu sampai 5 detik, lalu menutup paksa sisa
//      proses TTOken Code.exe. Cancel dan mode senyap tetap membiarkannya
//      berjalan. Berlaku juga untuk uninstaller.
editFile({
  name: 'installer menutup aplikasi (single instance)',
  path: 'apps/desktop/src/single-instance.ts',
  pairs: [[desktopPart('single-instance.orig.ts.part'), desktopPart('single-instance.ts.part')]],
})
editFile({
  name: 'installer menutup aplikasi (uji single instance)',
  path: 'apps/desktop/tests/single-instance.spec.ts',
  pairs: [[desktopPart('single-instance.orig.spec.ts.part'), desktopPart('single-instance.spec.ts.part')]],
})
editFile({
  name: 'installer menutup aplikasi (main)',
  path: 'apps/desktop/src/main.ts',
  pairs: [[
    `const ownsDesktopInstance = claimDesktopSingleInstance(app, () => { focusPrimaryWindow() })\n`,
    `const ownsDesktopInstance = claimDesktopSingleInstance(app, process.argv, () => { focusPrimaryWindow() }, () => {\n`
      + `  quitWithoutConfirmation()\n})\n`,
  ]],
})
editFile({
  name: 'installer menutup aplikasi (NSIS)',
  path: 'apps/desktop/scripts/installer.nsh',
  pairs: [
    [desktopPart('check-app-running.orig.nsh.part'), desktopPart('check-app-running.nsh.part')],
    [`!macro customCheckAppRunning\n`, desktopPart('wait-app-exit.nsh.part') + `\n!macro customCheckAppRunning\n`],
  ],
})
for (const [path, from, to] of [
    ['apps/desktop/installer/locales/en_US.json', `    "INSTALLER_RUNNING": "TTOken Code is running. Quit it from the system tray and try again.",
`, `    "INSTALLER_RUNNING": "TTOken Code is running. Quit it from the system tray and try again.",
    "INSTALLER_RUNNING_CLOSE": "TTOken Code is still running. Close it and continue? Running tasks will be interrupted.",\n`],
    ['apps/desktop/installer/locales/de_DE.json', `    "INSTALLER_RUNNING": "TTOken Code läuft. Beenden Sie es über die Taskleiste und versuchen Sie es erneut.",
`, `    "INSTALLER_RUNNING": "TTOken Code läuft. Beenden Sie es über die Taskleiste und versuchen Sie es erneut.",
    "INSTALLER_RUNNING_CLOSE": "TTOken Code läuft noch. Schließen und fortfahren? Laufende Aufgaben werden unterbrochen.",\n`],
    ['apps/desktop/installer/locales/es_ES.json', `    "INSTALLER_RUNNING": "TTOken Code se está ejecutando. Salga de la bandeja del sistema y vuelva a intentarlo.",
`, `    "INSTALLER_RUNNING": "TTOken Code se está ejecutando. Salga de la bandeja del sistema y vuelva a intentarlo.",
    "INSTALLER_RUNNING_CLOSE": "TTOken Code sigue en ejecución. ¿Cerrarlo y continuar? Las tareas en curso se interrumpirán.",\n`],
    ['apps/desktop/installer/locales/fr_FR.json', `    "INSTALLER_RUNNING": "TTOken Code est en cours d'exécution. Quittez-le de la barre d'état système et réessayez.",
`, `    "INSTALLER_RUNNING": "TTOken Code est en cours d'exécution. Quittez-le de la barre d'état système et réessayez.",
    "INSTALLER_RUNNING_CLOSE": "TTOken Code est toujours en cours d'exécution. Le fermer et continuer ? Les tâches en cours seront interrompues.",\n`],
    ['apps/desktop/installer/locales/ja_JP.json', `    "INSTALLER_RUNNING": "TTOken Code が実行中です。システムトレイから終了して再試行してください。",
`, `    "INSTALLER_RUNNING": "TTOken Code が実行中です。システムトレイから終了して再試行してください。",
    "INSTALLER_RUNNING_CLOSE": "TTOken Code はまだ実行中です。終了して続行しますか？実行中のタスクは中断されます。",\n`],
    ['apps/desktop/installer/locales/pt_BR.json', `    "INSTALLER_RUNNING": "TTOken Code está em execução. Saia da bandeja do sistema e tente novamente.",
`, `    "INSTALLER_RUNNING": "TTOken Code está em execução. Saia da bandeja do sistema e tente novamente.",
    "INSTALLER_RUNNING_CLOSE": "O TTOken Code ainda está em execução. Fechar e continuar? As tarefas em andamento serão interrompidas.",\n`],
    ['apps/desktop/installer/locales/ru_RU.json', `    "INSTALLER_RUNNING": "TTOken Code работает. Закройте его из системного трея и повторите попытку.",
`, `    "INSTALLER_RUNNING": "TTOken Code работает. Закройте его из системного трея и повторите попытку.",
    "INSTALLER_RUNNING_CLOSE": "TTOken Code всё ещё работает. Закрыть его и продолжить? Выполняемые задачи будут прерваны.",\n`],
    ['apps/desktop/installer/locales/zh_CN.json', `    "INSTALLER_RUNNING": "TTOken Code 正在运行，请先在系统托盘中退出应用后重试。",
`, `    "INSTALLER_RUNNING": "TTOken Code 正在运行，请先在系统托盘中退出应用后重试。",
    "INSTALLER_RUNNING_CLOSE": "TTOken Code 仍在运行。是否关闭并继续？正在运行的任务将被中断。",\n`],
]) editFile({ name: `installer menutup aplikasi (${path.split('/').pop()})`, path, pairs: [[from, to]] })
editFile({
  name: 'installer menutup aplikasi (uji locale)',
  path: 'apps/desktop/tests/installer-locales.spec.ts',
  pairs: [[
    `  expect(source.match(/^LangString /gmu)).toHaveLength(256)\n`,
    `  expect(source.match(/^LangString /gmu)).toHaveLength(264)\n`,
  ]],
})
editFile({
  name: 'installer menutup aplikasi (uji smoke Windows)',
  path: 'apps/desktop/tests/windows-installer-smoke.ps1',
  pairs: [
    [`        [void](Wait-Control $Setup $copy.INSTALLER_RUNNING -Dialog)\n`,
      `        [void](Wait-Control $Setup $copy.INSTALLER_RUNNING_CLOSE -Dialog)\n`],
    [`        Dismiss $Setup $copy.INSTALLER_RUNNING\n`, `        Dismiss $Setup $copy.INSTALLER_RUNNING_CLOSE\n`],
  ],
})
editFile({
  name: 'installer menutup aplikasi (README desktop)',
  path: 'apps/desktop/README.md',
  pairs: [[`The Windows installer and uninstaller tell a user whose application is still running to quit it from the system tray.`, `When the application is still running, the Windows installer and uninstaller offer to close it. OK launches the installed executable with \`--quit-for-installer\`, which makes the running instance quit without this confirmation because the installer prompt already warned that running tasks stop; after five seconds the installer ends the remaining application processes, and if they still run it tells the user to quit from the system tray. Cancel and silent runs keep the application running.`]],
})
editFile({
  name: 'installer menutup aplikasi (README desktop zh)',
  path: 'apps/desktop/README.zh.md',
  pairs: [[`Windows 安装程序和卸载程序在应用仍在运行时提示用户先在系统托盘中退出。`, `应用仍在运行时，Windows 安装程序和卸载程序会提供关闭它的选项。点击“确定”后，安装程序以 \`--quit-for-installer\` 启动已安装的可执行文件，正在运行的实例跳过此确认直接退出，因为安装程序的提示已说明运行中的任务会停止；五秒后安装程序结束剩余的应用进程，若仍未退出，则提示用户先在系统托盘中退出。点击“取消”或静默运行时应用保持运行。`]],
})
editFile({
  name: 'installer menutup aplikasi (README packaging)',
  path: 'apps/desktop/packaging/README.md',
  pairs: [[`A running application blocks installation; update launches allow up to ten seconds for it to exit.`, `A running application blocks installation until the user lets the installer close it or quits it; update launches allow up to ten seconds for it to exit, and silent runs never close it.`]],
})
editFile({
  name: 'installer menutup aplikasi (README packaging zh)',
  path: 'apps/desktop/packaging/README.zh.md',
  pairs: [[`运行中的应用会阻止安装；更新启动允许等待应用退出，最长十秒。`, `运行中的应用会阻止安装，直到用户允许安装器关闭它或自行退出；更新启动允许等待应用退出，最长十秒；静默运行从不关闭应用。`]],
})
editFile({
  name: 'installer menutup aplikasi (pasangan terjemahan README)',
  path: 'apps/desktop/README.i18n.yaml',
  pairs: [[`  en: bb35a022c37955c9\n  zh: ab2ef22d398d83a0\n`, `  en: cc9a70f0738cdf10\n  zh: c00a597e8f58f1db\n`]],
})
editFile({
  name: 'installer menutup aplikasi (pasangan terjemahan README packaging)',
  path: 'apps/desktop/packaging/README.i18n.yaml',
  pairs: [[`  en: da4669b98c79ee48\n  zh: d007e87f13ff54d3\n`, `  en: 4c17203db1ddf72b\n  zh: bb8e597cee8c7f94\n`]],
})

// 30. Layar progres installer: logo TTOken terisi air sedikit demi sedikit
//      (volume mengikuti bentuk T, gelombang permukaan, gelembung naik),
//      persentase besar di bawahnya, tahap instalasi, dan wordmark kecil di kaki
//      halaman. Latar tidak lagi polos: gradasi hangat dan cahaya kunyit di
//      belakang logo; pita tombol judul tetap rata. Sumber di ttoken/installer/.
writeGenerated('installer air (fisika)', 'apps/desktop/installer/water-fill.h', installerPart('water-fill.h'))
editFile({
  name: 'installer air (halaman progres)',
  path: 'apps/desktop/installer/window-frame.cpp',
  pairs: ['includes', 'progress-header', 'page', 'helpers', 'reveal', 'finish-control', 'paint', 'show']
    .map(part => [installerPart(`window-frame/${part}.orig.part`), installerPart(`window-frame/${part}.part`)]),
})
editFile({
  name: 'installer air (README desktop)',
  path: 'apps/desktop/README.md',
  pairs: [[`The progress page keeps one opaque pixel buffer for its lifetime, draws static artwork once, and copies repainted pixels with GDI.`, `The progress page keeps one opaque pixel buffer and a copy of its static backdrop for its lifetime; every frame restores the backdrop, draws the water-filled mark, the percentage and the stage, and copies repainted pixels with GDI.`]],
})
editFile({
  name: 'installer air (README desktop zh)',
  path: 'apps/desktop/README.zh.md',
  pairs: [[`进度页在其生命周期内保留一个不透明像素缓冲，只绘制一次静态图像，并通过 GDI 复制重绘的像素。`, `进度页在其生命周期内保留一个不透明像素缓冲和一份静态背景副本；每一帧先恢复背景，再绘制注水的标志、百分比和当前阶段，并通过 GDI 复制重绘的像素。`]],
})
editFile({
  name: 'installer air (pasangan terjemahan README)',
  path: 'apps/desktop/README.i18n.yaml',
  pairs: [[`  en: eb9d30bca4134f80\n  zh: bf201d18ae5ba697\n`, `  en: f8c4a4dde188a0fd\n  zh: afc80c7f54135cd8\n`]],
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
    `  return nativeTheme.shouldUseDarkColors ? '#111111' : '#f4efe4'\n`,
  ]],
})

// 31. Desain terang dari sistem desain TTOken Marketing (kanvas "TTOken Code Desktop:
//     Tata Letak", halaman "Redesign terang"). Palet dan fon ada di aturan 22 dan 23,
//     composer di aturan 24; bagian di bawah ini sisanya.

// 31a. Tampilan terang menjadi bawaan. User tetap bisa memilih gelap atau ikut sistem
//      di Settings; pilihan yang tersimpan tidak diubah.
editFile({
  name: 'tema terang bawaan',
  path: 'packages/client/ui-theme/src/theme-settings.ts',
  pairs: [[`export const DEFAULT_PREFERENCE: ThemePreference = 'system'\n`, `export const DEFAULT_PREFERENCE: ThemePreference = 'light'\n`]],
})
editFile({
  name: 'tema terang bawaan (test runtime)',
  path: 'packages/client/ui-theme/tests/theme.client.spec.ts',
  pairs: [
    [
      `  it('defaults to the system preference resolved against prefers-color-scheme', () => {\n    const { theme } = make()\n    const snapshot = theme.getTheme()\n    expect(snapshot.preference).toBe('system')\n    expect(snapshot.fontSizes.text).toBe(14)\n    // jsdom matchMedia is absent; system resolves to light.\n`,
      `  it('defaults to the light preference', () => {\n    const { theme } = make()\n    const snapshot = theme.getTheme()\n    expect(snapshot.preference).toBe('light')\n    expect(snapshot.fontSizes.text).toBe(14)\n`,
    ],
    [
      `      expect(make().theme.getTheme().preference).toBe('system')\n    } finally {\n`,
      `      expect(make().theme.getTheme().preference).toBe('light')\n    } finally {\n`,
    ],
    [
      `    dispose()\n    expect(theme.getTheme().preference).toBe('system')\n`,
      `    dispose()\n    expect(theme.getTheme().preference).toBe('light')\n`,
    ],
    [
      `      const { theme, events } = make()\n      expect(theme.getTheme().preference).toBe('system')\n      expect(theme.getTheme().active.id).toBe('dark')\n      media.flip()\n      expect(theme.getTheme().active.id).toBe('light')\n      expect(events).toHaveLength(1)\n`,
      `      const { theme, events } = make()\n      theme.setTheme('system')\n      expect(theme.getTheme().preference).toBe('system')\n      expect(theme.getTheme().active.id).toBe('dark')\n      media.flip()\n      expect(theme.getTheme().active.id).toBe('light')\n      expect(events).toHaveLength(2)\n`,
    ],
    [
      `      theme.setTheme('light')\n      expect(events).toHaveLength(1)\n      media.flip()\n      expect(events).toHaveLength(1)\n      expect(theme.getTheme().active.id).toBe('light')\n`,
      `      theme.setTheme('dark')\n      expect(events).toHaveLength(1)\n      media.flip()\n      expect(events).toHaveLength(1)\n      expect(theme.getTheme().active.id).toBe('dark')\n`,
    ],
  ],
})
editFile({
  name: 'tema terang bawaan (test host)',
  path: 'packages/client/ui-theme/tests/config.host.spec.ts',
  pairs: [
    [
      `    expect(rowText(rows[0])).toContain('@media(prefers-color-scheme:dark)')\n    expect(rowText(rows[1])).toContain('const preference = "system"')\n`,
      `    expect(rowText(rows[0])).toContain('color-scheme:light')\n    expect(rowText(rows[0])).not.toContain('@media(prefers-color-scheme:dark)')\n    expect(rowText(rows[1])).toContain('const preference = "light"')\n`,
    ],
    [
      `  it('uses the system preference without a settings provider', async () => {\n    const ctx = new Context()\n    await ctx.plugin({ Config, apply }).await()\n    expect(rowText(collect(ctx)[1])).toContain('const preference = "system"')\n`,
      `  it('uses the light preference without a settings provider', async () => {\n    const ctx = new Context()\n    await ctx.plugin({ Config, apply }).await()\n    expect(rowText(collect(ctx)[1])).toContain('const preference = "light"')\n`,
    ],
  ],
})

// 31b. Gelembung pesan user: kartu putih bergaris dengan sudut kanan bawah lebih kecil.
editFile({
  name: 'gelembung pesan user',
  path: 'packages/client/ui-primitives/src/UserMessageBubble.module.css',
  pairs: [[
    `  background: var(--dsw-specific-bubble);\n  border-radius: var(--dsw-radius-xl);\n`,
    `  background: var(--dsw-specific-bubble);\n  /* TTOken Code: white card with a hairline border; the corner nearest the sender is tighter. */\n  border: 0.5px solid var(--dsw-alias-border-l4);\n  border-radius: var(--dsw-radius-lg) var(--dsw-radius-lg) var(--dsw-radius-xs) var(--dsw-radius-lg);\n`,
  ]],
})

// 31c. Beranda: judul Archivo yang menyebut Workspace terpilih dan satu baris petunjuk,
//      tanpa mark dan lencana pratinjau. Judul pemilik (`headline`) tetap menggantikan keduanya.
const EMPTY_HERO_PATH = 'packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx'
editFile({
  name: 'beranda (impor)',
  path: EMPTY_HERO_PATH,
  pairs: [
    [
      `// phase does not remount its textarea.\n\nimport { useState } from 'react'\nimport type { ReactNode, RefObject } from 'react'\n`,
      `// phase does not remount its textarea.\n\nimport type { ReactNode, RefObject } from 'react'\n`,
    ],
    [
      `  FISH_LOGO_PATH, FISH_LOGO_VIEWBOX, IconChevronDownOutlineRegular, IconFolderCloseRegular, IconFolderOpenRegular,\n`,
      `  IconChevronDownOutlineRegular, IconFolderCloseRegular, IconFolderOpenRegular,\n`,
    ],
  ],
})
replaceRegion({
  name: 'beranda (judul)',
  path: EMPTY_HERO_PATH,
  start: `/** Hero chrome props. The workspace row rides the InputBar accessory hole, not here. */\n`,
  end: '',
  content: clientPart('hero/HeroShell.tsx.part'),
})
editFile({
  name: 'beranda (gaya)',
  path: 'packages/client/ui-conversation/src/client/skeleton/HeroShell.module.css',
  pairs: [[
    `.modalError {\n  margin-top: 8px;\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-state-error-primary);\n}\n`,
    `.modalError {\n  margin-top: 8px;\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-state-error-primary);\n}\n\n${clientPart('hero/HeroShell.css.part')}`,
  ]],
})
editFile({
  name: 'beranda (nama Workspace)',
  path: 'packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx',
  pairs: [[
    `<HeroShell t={t} renderSlot={renderSlot} headline={props.headline} />`,
    `<HeroShell t={t} workspace={chipTitle} headline={props.headline} />`,
  ]],
})
// Urutan kamus percakapan: zh, en, ja, es, fr, de, ru, pt.
setLocaleValues({
  name: 'beranda (judul tanpa Workspace)',
  path: 'packages/client/ui-conversation/src/client/locales.ts',
  key: 'hero.headline',
  values: ['要构建什么？', 'What should we build?', '何を作りましょうか？', '¿Qué construimos?', 'Que construisons-nous ?', 'Was sollen wir bauen?', 'Что будем создавать?', 'O que vamos construir?'],
})
insertLocaleKey({
  name: 'beranda (judul dengan Workspace)',
  path: 'packages/client/ui-conversation/src/client/locales.ts',
  after: 'hero.headline',
  key: 'hero.headlineWorkspace',
  values: [
    '要在 {name} 中构建什么？', 'What should we build in {name}?', '{name} で何を作りましょうか？', '¿Qué construimos en {name}?',
    'Que construisons-nous dans {name} ?', 'Was sollen wir in {name} bauen?', 'Что будем создавать в {name}?', 'O que vamos construir em {name}?',
  ],
})
insertLocaleKey({
  name: 'beranda (petunjuk)',
  path: 'packages/client/ui-conversation/src/client/locales.ts',
  after: 'hero.headlineWorkspace',
  key: 'hero.subtitle',
  values: [
    '描述一项修改，用 @ 提及文件，或从 GitHub 领取一个 issue。',
    'Describe a change, mention files with @, or pick up an issue from GitHub.',
    '変更内容を説明するか、@ でファイルを指定するか、GitHub の issue を選んでください。',
    'Describe un cambio, menciona archivos con @ o toma un issue de GitHub.',
    'Décrivez une modification, mentionnez des fichiers avec @ ou reprenez une issue GitHub.',
    'Beschreiben Sie eine Änderung, erwähnen Sie Dateien mit @ oder übernehmen Sie ein Issue von GitHub.',
    'Опишите изменение, упомяните файлы через @ или возьмите задачу из GitHub.',
    'Descreva uma mudança, mencione arquivos com @ ou pegue uma issue do GitHub.',
  ],
})
editFile({
  name: 'beranda (test komposer)',
  path: 'packages/client/ui-conversation/tests/skeleton.client.spec.tsx',
  pairs: [
    [
      `    expect(b.view.getByText('探索未至之境')).toBeTruthy()\n    expect(b.view.getByText('预览版')).toBeTruthy()\n`,
      `    expect(b.view.getByRole('heading', { name: /构建什么？$/ })).toBeTruthy()\n`,
    ],
    [`    expect(b.view.queryByText('探索未至之境')).toBeNull()\n`, `    expect(b.view.queryByRole('heading', { name: /构建什么？$/ })).toBeNull()\n`],
    [
      `    expect(b.view.getByText('探索未至之境')).toBeTruthy()\n    expect(b.view.getByRole('textbox')).toBeTruthy()\n`,
      `    expect(b.view.getByRole('heading', { name: /构建什么？$/ })).toBeTruthy()\n    expect(b.view.getByRole('textbox')).toBeTruthy()\n`,
    ],
  ],
})
replaceRegion({
  name: 'beranda (test)',
  path: 'packages/client/ui-conversation/tests/skeleton.client.spec.tsx',
  start: `describe('Hero chrome', () => {\n`,
  end: `describe('ConversationRoot resident composer', () => {\n`,
  content: `${clientPart('hero/hero.spec.part')}\n`,
})

// 31d. Sidebar: lockup tinta dengan nama produk Archivo, tombol New session hitam
//      dengan pintasan yang selalu terlihat, dan baris navigasi aktif berwarna putih.
editFile({
  name: 'sidebar terang',
  path: 'packages/client/ui-sidebar/src/client/SidebarRoot.module.css',
  pairs: [[
    `  /* The delay is not motion: keep it and drop only the fade. */\n  .root.quietBars {\n    transition-duration: 0s;\n  }\n}\n`,
    `  /* The delay is not motion: keep it and drop only the fade. */\n  .root.quietBars {\n    transition-duration: 0s;\n  }\n}\n${clientPart('sidebar/SidebarRoot.css.part')}`,
  ]],
})

// 31e. Navigasi sidebar dari desain terang: navigasi utama hanya berisi panel kerja
//      (Code review) dan baris Device yang membuka panel Perangkat Android di sidebar
//      kanan. Plugins dan Automation pindah ke atas kartu Settings; menu More upstream
//      tidak ditampilkan. Baris disembunyikan lewat CSS, jadi urutan dan pin upstream tetap.
const SIDEBAR_ROOT = 'packages/client/ui-sidebar/src/client/SidebarRoot.tsx'
writeGenerated('sidebar (navigasi)', 'packages/client/ui-sidebar/src/client/ttoken-nav.tsx', clientPart('sidebar/ttoken-nav.tsx'))
editFile({
  name: 'sidebar (susunan)',
  path: SIDEBAR_ROOT,
  pairs: [
    [
      `  FishLogo, IconAppsAddOutlineRegular, IconNewChatOutlineMedium, IconNewChatOutlineRegular,\n`,
      `  FishLogo, IconAppsAddOutlineRegular, IconNewChatOutlineRegular, IconPlusOutlineMedium,\n`,
    ],
    [`import css from './SidebarRoot.module.css'\n`, `import css from './SidebarRoot.module.css'\nimport { TTOKEN_FOOT_PANELS, TtokenDeviceRow, useDeviceAvailable } from './ttoken-nav.tsx'\n`],
    [
      `    <div className={clsx(css.panelEntry, wide && css.panelEntryWide, active && css.panelEntryActive)}>\n`,
      `    <div className={clsx(css.panelEntry, wide && css.panelEntryWide, active && css.panelEntryActive)} data-panel-id={id}>\n`,
    ],
    [`  useEntryActions,\n  useShortcuts,\n`, `  useEntryActions,\n  deviceNav,\n  openDevice,\n  useShortcuts,\n`],
    [
      `  const hasEntryActions = useEntryActions(registered => registered)\n`,
      `  const hasEntryActions = useEntryActions(registered => registered)\n  const deviceAvailable = useDeviceAvailable(deviceNav)\n`,
    ],
    [`                      ? <IconNewChatOutlineMedium size={14} />\n`, `                      ? <IconPlusOutlineMedium size={16} />\n`],
    [
      `              ))}\n              {hasEntryActions && (\n                <PanelMoreMenu\n`,
      `              ))}\n              {deviceAvailable && openDevice !== undefined && <TtokenDeviceRow wide={wide} label={t('ttoken.device')} onOpen={openDevice} />}\n              {hasEntryActions && (\n                <PanelMoreMenu\n`,
    ],
    [
      `      <div className={css.footArea}>\n        <div className={css.footerActions}>\n`,
      `      <div className={css.footArea}>
        {/* TTOken Code: Plugins and Automation sit above the settings card, out of the main navigation. */}
        <div className={css.ttokenFootPanels}>
          {panels.filter(({ id }) => TTOKEN_FOOT_PANELS.includes(id)).map(({ id, label }) => (
            <PanelRow
              key={id}
              id={id}
              label={label}
              wide={wide}
              unpinLabel={t('panels.unpin', { name: label })}
              unpinTooltip={t('panels.unpinTooltip')}
              canUnpin={false}
              setPinned={setPinned}
              usePanelInfo={usePanelInfo}
              selectPanel={selectPanel}
              trackEntryClick={trackEntryClick}
              renderFactorySlot={renderFactorySlot}
            />
          ))}
        </div>
        <div className={css.footerActions}>\n`,
    ],
  ],
})
editFile({
  name: 'sidebar (kontrak)',
  path: 'packages/client/ui-sidebar/src/client/contract/slots.ts',
  pairs: [[
    `  /** Record activation of an official navigation control without changing navigation. */\n  trackEntryClick: (attributes: ProductEventMap['sidebar_menu_click']) => void\n`,
    `  /** Record activation of an official navigation control without changing navigation. */\n  trackEntryClick: (attributes: ProductEventMap['sidebar_menu_click']) => void\n  /** TTOken Code: open the Android device page in the right sidebar of the on-screen Session. */\n  openDevice?: (() => void) | undefined\n  /** TTOken Code: whether the Android device page type is registered; absent hides the Device row. */\n  deviceNav?: ObservableSnapshot<boolean> | undefined\n`,
  ]],
})
editFile({
  name: 'sidebar (sambungan)',
  path: 'packages/client/ui-sidebar/src/client/index.ts',
  pairs: [
    [`import { createPanelPins } from './panel-pins.ts'\n`, `import { createPanelPins } from './panel-pins.ts'\nimport { createDeviceNav } from './ttoken-nav.tsx'\n`],
    [
      `  const panelPins = createPanelPins()\n`,
      `  const panelPins = createPanelPins()\n  const ttokenDevice = createDeviceNav(ctx)\n`,
    ],
    [
      `    trackEntryClick: (attributes) => { ctx.get('productAnalytics')?.track('sidebar_menu_click', attributes) },\n`,
      `    trackEntryClick: (attributes) => { ctx.get('productAnalytics')?.track('sidebar_menu_click', attributes) },\n    openDevice: ttokenDevice.open,\n    deviceNav: ttokenDevice.available,\n`,
    ],
  ],
})
editFile({
  name: 'sidebar (test sambungan)',
  path: 'packages/client/ui-sidebar/tests/apply.client.spec.tsx',
  pairs: [[
    `    expect(Object.keys(injected)).toEqual(['startSession', 'toggleSidebar', 'selectPanel', 'setPinned', 'trackEntryClick', 'hooks'])\n`,
    `    expect(Object.keys(injected)).toEqual(['startSession', 'toggleSidebar', 'selectPanel', 'setPinned', 'trackEntryClick', 'openDevice', 'deviceNav', 'hooks'])\n    expect(injected.deviceNav?.getSnapshot()).toBe(false)\n`,
  ]],
})
// Urutan kamus sidebar: zh, en, ja, es, fr, de, ru, pt.
setLocaleValues({
  name: 'sidebar (tombol sesi baru)',
  path: 'packages/client/ui-sidebar/src/client/locales.ts',
  key: 'session.new',
  values: ['新会话', 'New session', '新規セッション', 'Nueva sesión', 'Nouvelle séance', 'Neue Sitzung', 'Новая сессия', 'Nova sessão'],
})
insertLocaleKey({
  name: 'sidebar (baris Device)',
  path: 'packages/client/ui-sidebar/src/client/locales.ts',
  after: 'navigation.label',
  key: 'ttoken.device',
  values: ['设备', 'Device', 'デバイス', 'Dispositivo', 'Appareil', 'Gerät', 'Устройство', 'Dispositivo'],
})
editFile({
  name: 'sidebar (sesi terpilih)',
  path: 'packages/client/ui-workspace/src/client/rows/Rows.module.css',
  pairs: [[
    `@media (prefers-reduced-motion: reduce) {\n  .arrow {\n    animation: none;\n    transition: none;\n  }\n}\n`,
    `@media (prefers-reduced-motion: reduce) {\n  .arrow {\n    animation: none;\n    transition: none;\n  }\n}\n\n/* TTOken Code: the selected Session row is white on the paper column, like the active navigation row. */\n.sessionRow.selected {\n  background-color: var(--dsw-specific-sidebar-nav-item-active);\n  font-weight: 500;\n}\n`,
  ]],
})

editFile({
  name: 'sidebar (test sesi terpilih)',
  path: 'packages/client/ui-workspace/tests/browser-styles.client.spec.ts',
  pairs: [[
    `    expect(rowDeclarations('.sessionRow.selected')?.get('background-color'))\n      .toBe('var(--dsw-alias-interactive-bg-hover)')\n`,
    `    expect(rowDeclarations('.sessionRow.selected')?.get('background-color'))\n      .toBe('var(--dsw-specific-sidebar-nav-item-active)')\n`,
  ]],
})

// 31f. Kartu Settings di kaki sidebar: mark TTOken di lingkaran tinta, label Settings,
//      dan ikon roda gigi, di atas kartu bergaris tipis. Di rel yang diciutkan tetap ikon saja.
editFile({
  name: 'kartu settings (isi)',
  path: 'packages/client/ui-settings-general/src/client/chrome.tsx',
  pairs: [
    [`import { IconSettingsOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'\n`, `import { FishLogo, IconSettingsOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'\n`],
    [
      `/**\n * Render the trigger row content (icon; label only in the wide column).\n * @param props - composed slot props.\n * @returns the trigger content fragment.\n */\nexport function TriggerContent({ wide, t }: TriggerContentProps) {\n  return (\n    <>\n      <IconSettingsOutlineMedium size={wide ? 16 : 18} />\n      {wide && <span className={css.triggerLabel}>{t('trigger')}</span>}\n    </>\n  )\n}\n`,
      `/**\n * Render the trigger row content: in the wide column the TTOken mark on an ink\n * disc, the label, and a trailing gear; in the rail the gear alone.\n * @param props - composed slot props.\n * @returns the trigger content fragment.\n */\nexport function TriggerContent({ wide, t }: TriggerContentProps) {\n  if (!wide) return <IconSettingsOutlineMedium size={18} />\n  return (\n    <>\n      <span className={css.ttokenAvatar} aria-hidden="true"><FishLogo size={18} /></span>\n      <span className={css.triggerLabel}>{t('trigger')}</span>\n      <IconSettingsOutlineMedium size={16} className={css.ttokenGear} />\n    </>\n  )\n}\n`,
    ],
  ],
})
editFile({
  name: 'kartu settings (gaya isi)',
  path: 'packages/client/ui-settings-general/src/client/chrome.module.css',
  pairs: [[
    `.triggerLabel {\n  overflow: hidden;\n  white-space: nowrap;\n}\n`,
    `.triggerLabel {\n  overflow: hidden;\n  white-space: nowrap;\n}\n
/* TTOken Code: the settings card's mark on an ink disc and its trailing gear. */
.ttokenAvatar {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-foreground);
}

.ttokenGear {
  flex: none;
  margin-left: auto;
  color: var(--dsw-alias-label-secondary);
}
`,
  ]],
})
editFile({
  name: 'kartu settings (gaya kartu)',
  path: 'packages/client/ui-settings-general/src/client/SettingsRoot.module.css',
  pairs: [[
    `   overlaps a chrome row's drag — including above every column, which an in-root\n   overlay could not promise once a chrome row declares drag itself. */\n`,
    `   overlaps a chrome row's drag — including above every column, which an in-root\n   overlay could not promise once a chrome row declares drag itself. */\n
/* TTOken Code: in the wide column the settings trigger is a card on the paper column. */
.trigger:not(.rail) {
  gap: 10px;
  height: 52px;
  padding: 0 12px 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-base);
  background-clip: border-box;
}

@media (hover: hover) {
  .trigger:not(.rail):hover {
    background: var(--dsw-alias-interactive-bg-hover-solid);
  }
}
`,
  ]],
})

for (const line of report) console.log(line)
if (failures.length > 0) {
  for (const line of failures) console.error(`GAGAL  ${line}`)
  process.exit(1)
}
