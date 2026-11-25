// Tests van de stijlcontrole zelf, en controle dat de eigen bronbestanden eraan voldoen.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { checkDirectories, checkText } from '../tools/check-stijl.mjs'

describe('checkText', () => {
  it('keurt een net bestand goed', () => {
    const text = '// Kop.\n/**\n * Doet iets.\n */\nexport function doeIets() {}\n'
    expect(checkText('a.ts', text)).toEqual([])
  })
  it('vangt een bestand zonder kopcommentaar', () => {
    expect(checkText('a.ts', 'export const waarde = 1\n').join('\n')).toContain('kopcommentaar')
  })
  it('vangt een functie zonder doc-blok', () => {
    expect(checkText('a.ts', '// Kop.\nexport function doeIets() {}\n').join('\n')).toContain('functie zonder')
  })
  it('vangt een pijlfunctie zonder doc-blok', () => {
    expect(checkText('a.ts', '// Kop.\nexport const doeIets = (waarde: number) => waarde\n').join('\n')).toContain('functie zonder')
  })
  it('vangt namen van één letter', () => {
    expect(checkText('a.ts', '// Kop.\nconst q = 1\n').join('\n')).toContain('één letter')
    expect(checkText('a.ts', '// Kop.\nitems.map((r) => r)\n').join('\n')).toContain('één letter')
    expect(checkText('a.ts', '// Kop.\nfor (let i = 0; i < 2; i++) {}\n')).toEqual([])
  })
  it('vangt v-html en adressen met een begin-slash', () => {
    expect(checkText('a.vue', '<script setup lang="ts">\n// Kop.\n</script>\n<template><div v-html="x"></div></template>\n').join('\n')).toContain('v-html')
    expect(checkText('a.ts', "// Kop.\nfetch('/api/x')\n").join('\n')).toContain('relatief')
  })
})

describe('eigen bronbestanden', () => {
  it('voldoen aan de stijlregels', () => {
    const root = process.cwd()
    expect(checkDirectories([join(root, 'src'), join(root, 'tools')])).toEqual([])
  })
})
