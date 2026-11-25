// Tests van het invoegen van de schil in een modulepagina.
import { describe, expect, it } from 'vitest'
import { HEAD_MARKER, SCRIPT_MARKER, SHELL_SCRIPTS, SHELL_STYLES, injectShell } from '../tools/shell-html'

describe('injectShell', () => {
  it('vervangt beide markeringen door relatieve tags', () => {
    const out = injectShell(`<head>${HEAD_MARKER}</head><body>${SCRIPT_MARKER}</body>`)
    expect(out).not.toContain(HEAD_MARKER)
    expect(out).not.toContain(SCRIPT_MARKER)
    for (const href of SHELL_STYLES) expect(out).toContain(`<link rel="stylesheet" href="${href}">`)
    for (const src of SHELL_SCRIPTS) expect(out).toContain(`<script src="${src}"></script>`)
  })

  it('gebruikt alleen relatieve adressen (geen begin-slash, geen CDN)', () => {
    for (const path of [...SHELL_STYLES, ...SHELL_SCRIPTS]) expect(path.startsWith('../')).toBe(true)
  })

  it('laadt de zijbalk pas na het moduleregister en vóór het rekeningmenu', () => {
    const order = SHELL_SCRIPTS.map((path) => path.split('/').pop())
    expect(order.indexOf('modules.js')).toBeLessThan(order.indexOf('sidebar.js'))
    expect(order.indexOf('sidebar.js')).toBeLessThan(order.indexOf('account.js'))
  })
})
