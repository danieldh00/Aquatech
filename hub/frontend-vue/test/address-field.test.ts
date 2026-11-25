// Tests van het adresveld: de postcodezoeker van de schil wordt gekoppeld en wijzigingen komen via v-model terug.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AddressField from '@/shared/AddressField.vue'

afterEach(() => { delete (window as unknown as Record<string, unknown>).AddressLookup })

describe('AddressField', () => {
  it('zet de waarde in het veld en koppelt de zoeker en de tekst', () => {
    const enhance = vi.fn()
    const mirror = vi.fn()
    ;(window as unknown as Record<string, unknown>).AddressLookup = { enhance, mirror }
    const wrapper = mount(AddressField, { props: { modelValue: 'Kerkstraat 1\n1234 AB Plaats' }, attachTo: document.body })
    const field = wrapper.find('textarea').element as HTMLTextAreaElement
    expect(field.value).toBe('Kerkstraat 1\n1234 AB Plaats')
    expect(enhance).toHaveBeenCalledWith(field)
    expect(mirror).toHaveBeenCalledWith(field, wrapper.find('.addr-text').element)
    wrapper.unmount()
  })

  it('meldt een wijziging van de zoeker via update:modelValue', async () => {
    ;(window as unknown as Record<string, unknown>).AddressLookup = { enhance: vi.fn(), mirror: vi.fn() }
    const wrapper = mount(AddressField, { props: { modelValue: '' }, attachTo: document.body })
    const field = wrapper.find('textarea').element as HTMLTextAreaElement
    field.value = 'Dorpsstraat 5\n1111 AA Stad'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['Dorpsstraat 5\n1111 AA Stad'])
    wrapper.unmount()
  })

  it('volgt een waarde van buiten (bijvoorbeeld na een reset)', async () => {
    const wrapper = mount(AddressField, { props: { modelValue: 'Oud' }, attachTo: document.body })
    await wrapper.setProps({ modelValue: '' })
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('')
    wrapper.unmount()
  })

  it('zet het handmatig-vlag voor een adres buiten Nederland', async () => {
    const wrapper = mount(AddressField, { props: { modelValue: '', manual: true }, attachTo: document.body })
    const field = wrapper.find('textarea').element as HTMLTextAreaElement
    expect(field.dataset.addressManual).toBe('1')
    await wrapper.setProps({ manual: false })
    expect(field.dataset.addressManual).toBeUndefined()
    wrapper.unmount()
  })

  it('werkt ook zonder schil (dan blijft het bij gewone tekst)', () => {
    const wrapper = mount(AddressField, { props: { modelValue: 'Straat 1' }, attachTo: document.body })
    expect(wrapper.find('.addr-text').text()).toBe('Straat 1')
    wrapper.unmount()
  })
})
