// Stijlcontrole voor de Vue-bronbestanden (.ts en .vue), gelijk aan de regels van de oude frontend (test/codestyle.test.js):
//  - een bestand begint met een kopcommentaar;
//  - elke benoemde functie heeft een /** … */-blok erboven;
//  - geen namen van één letter (behalve i, j, x, y en _);
//  - geen v-html (templates escapen zelf; v-html is een XSS-risico) en geen adressen die met / beginnen (alles relatief).
// Gebruik: node tools/check-stijl.mjs [map]   (standaard src/ en tools/). Eindigt met code 1 bij een overtreding.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ALLOWED_SINGLE = new Set(['i', 'j', 'x', 'y', '_'])

/**
 * Verzamelt alle .ts- en .vue-bestanden onder een map.
 * @param {string} directory De map.
 * @returns {string[]} Paden van de bestanden.
 */
export function collectFiles(directory) {
  const found = []
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules' || name === 'dist') continue
    const path = join(directory, name)
    if (statSync(path).isDirectory()) found.push(...collectFiles(path))
    else if (['.ts', '.vue'].includes(extname(path)) && !name.endsWith('.d.ts')) found.push(path)
  }
  return found
}

/**
 * Controleert één bestand.
 * @param {string} path Pad (voor de melding en om het type te bepalen).
 * @param {string} text De inhoud.
 * @returns {string[]} Overtredingen, elk als "pad:regel: melding".
 */
export function checkText(path, text) {
  const problems = []
  const lines = text.split('\n')
  const report = (lineNumber, message) => problems.push(`${path}:${lineNumber}: ${message}`)
  const firstContent = lines.findIndex((line) => line.trim() !== '')
  const head = lines.slice(firstContent, firstContent + 3).join('\n')
  const isVue = extname(path) === '.vue'
  const headerOk = isVue ? /<script[^>]*>\s*\n\s*(\/\/|\/\*)/.test(text) || /^<!--/.test(head) : /^(\/\/|\/\*)/.test(head.trim())
  if (!headerOk) report(firstContent + 1, 'bestand begint niet met een kopcommentaar')
  lines.forEach((line, index) => {
    const lineNumber = index + 1
    if (/v-html/.test(line)) report(lineNumber, 'v-html is verboden (gebruik tekst-interpolatie)')
    if (/(fetch|href=|src=)\s*\(?\s*["'`]\/(?!\/)/.test(line) || /\bfetch\(\s*["'`]\/[a-z]/.test(line)) report(lineNumber, 'adres begint met / (alles moet relatief zijn)')
    const declared = line.match(/\b(?:const|let|var)\s+([A-Za-z_$])\b(?!\w)/)
    if (declared && !ALLOWED_SINGLE.has(declared[1])) report(lineNumber, `naam van één letter: ${declared[1]}`)
    const params = line.match(/\(([^()]*)\)\s*(?::\s*[^=]+)?=>/)
    if (params) {
      for (const parameter of params[1].split(',')) {
        const name = parameter.trim().replace(/[:=?].*$/, '').trim()
        if (/^[A-Za-z$]$/.test(name) && !ALLOWED_SINGLE.has(name)) report(lineNumber, `parameter van één letter: ${name}`)
      }
    }
    const named = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*[A-Za-z_$][\w$]*\s*[(<]/.test(line)
      || /^\s*(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>/.test(line)
    if (named) {
      let previous = index - 1
      while (previous >= 0 && lines[previous].trim() === '') previous -= 1
      if (previous < 0 || !lines[previous].trim().endsWith('*/')) report(lineNumber, 'functie zonder /** … */-blok erboven')
    }
  })
  return problems
}

/**
 * Controleert alle bestanden onder de opgegeven mappen.
 * @param {string[]} directories De mappen.
 * @returns {string[]} Alle overtredingen.
 */
export function checkDirectories(directories) {
  return directories.flatMap((directory) => collectFiles(directory).flatMap((path) => checkText(path, readFileSync(path, 'utf8'))))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const directories = process.argv.length > 2 ? process.argv.slice(2) : [join(root, 'src'), join(root, 'tools')]
  const problems = checkDirectories(directories)
  if (problems.length) {
    console.error(problems.join('\n'))
    console.error(`\n${problems.length} overtreding(en) tegen de stijlregels.`)
    process.exit(1)
  }
  console.log('Stijlcontrole: geen overtredingen.')
}
