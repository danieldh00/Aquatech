// Tests van de API-client: relatieve adressen, JSON, foutmeldingen van de server en terugvalmeldingen.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, statusMessage } from '@/shared/api'

/**
 * Bootst fetch na met één antwoord.
 * @param status HTTP-status.
 * @param body JSON-body (of tekst die geen JSON is).
 * @returns De nagebootste fetch.
 */
function mockFetch(status: number, body: unknown) {
  const fake = vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fake)
  return fake
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).AquatechCommon
})

describe('api', () => {
  it('roept een relatief adres aan zonder cache', async () => {
    const fake = mockFetch(200, { items: [] })
    await api('customers?limit=50')
    const call = fake.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[0]).toBe('../api/customers?limit=50')
    expect(call[1].cache).toBe('no-store')
    expect(call[1].method).toBe('GET')
  })

  it('stuurt een body als JSON', async () => {
    const fake = mockFetch(200, { ok: true })
    await api('customers', { method: 'POST', body: { displayName: 'Jan' } })
    const call = fake.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[1].body).toBe('{"displayName":"Jan"}')
    expect(call[1].headers).toEqual({ 'Content-Type': 'application/json' })
  })

  it('geeft een fout met melding, veld en code van de server', async () => {
    mockFetch(400, { message: 'Naam ontbreekt', field: 'displayName', code: 'invalid' })
    const error = await api('customers').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ message: 'Naam ontbreekt', status: 400, field: 'displayName', code: 'invalid' })
  })

  it('valt terug op een leesbare melding bij een status zonder bericht', async () => {
    mockFetch(403, '<html>geen json</html>')
    await expect(api('customers')).rejects.toThrow('Je hebt hier geen recht toe.')
  })

  it('gebruikt de melding van de schil als die er is', async () => {
    ;(window as unknown as Record<string, unknown>).AquatechCommon = { statusMessage: (status: number) => `schil ${status}` }
    mockFetch(500, {})
    await expect(api('customers')).rejects.toThrow('schil 500')
    expect(statusMessage(404)).toBe('schil 404')
  })

  it('meldt een netwerkfout leesbaar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(api('customers')).rejects.toMatchObject({ status: 0, message: expect.stringContaining('Geen verbinding') })
  })

  it('geeft een leeg object bij een antwoord zonder inhoud', async () => {
    mockFetch(200, '')
    await expect(api('customers/1/invite', { method: 'POST', body: {} })).resolves.toEqual({})
  })
})
