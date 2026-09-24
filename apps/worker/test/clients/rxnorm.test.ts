import { describe, expect, it } from 'vitest'
import { RxNormClient } from '../../src/clients/rxnorm.ts'
import { UpstreamError } from '../../src/problems.ts'
import { json, mockFetch, rxnormFetch } from '../recorded.ts'

const BASE = 'https://rxnav.test'

function client(): RxNormClient {
  return new RxNormClient({ baseUrl: BASE, fetch: rxnormFetch() })
}

function failing(handler: (url: URL) => Response): RxNormClient {
  return new RxNormClient({ baseUrl: BASE, fetch: mockFetch(handler) })
}

describe('RxNormClient', () => {
  it('resolves a brand name to its ingredient', async () => {
    const result = await client().resolve('Advil')

    expect(result).not.toBeNull()
    expect(result?.query).toBe('Advil')
    expect(result?.matched_rxcui).toBe('153010')
    expect(result?.ingredients).toEqual([{ rxcui: '5640', name: 'ibuprofen' }])
    expect(result?.rxcui).toBe('5640')
  })

  it('still resolves a misspelled name', async () => {
    expect((await client().resolve('advill'))?.rxcui).toBe('5640')
  })

  it('resolves an ingredient name to itself', async () => {
    const result = await client().resolve('metformin')

    expect(result?.matched_rxcui).toBe('6809')
    expect(result?.ingredients).toEqual([{ rxcui: '6809', name: 'metformin' }])
    expect(result?.rxcui).toBe('6809')
  })

  it('uses the multi-ingredient concept for a combination product', async () => {
    const result = await client().resolve('Tylenol PM')

    expect(result?.ingredients).toEqual([
      { rxcui: '161', name: 'acetaminophen' },
      { rxcui: '3498', name: 'diphenhydramine' },
    ])
    expect(result?.rxcui).toBe('214181')
  })

  it('returns null for an unknown name', async () => {
    expect(await client().resolve('xyzzynotadrug')).toBeNull()
  })

  it('returns null for a blank name without calling RxNorm', async () => {
    const rxnorm = failing(() => {
      throw new Error('RxNorm must not be called for a blank name')
    })

    expect(await rxnorm.resolve('   ')).toBeNull()
  })

  it('raises UpstreamError on an HTTP error', async () => {
    const rxnorm = failing(() => new Response('unavailable', { status: 503 }))

    await expect(rxnorm.resolve('Advil')).rejects.toBeInstanceOf(UpstreamError)
  })

  it('raises UpstreamError on a malformed payload', async () => {
    const rxnorm = failing(() => json(200, { idGroup: { rxnormId: 'not-a-list' } }))

    await expect(rxnorm.resolve('Advil')).rejects.toBeInstanceOf(UpstreamError)
  })

  it('raises UpstreamError on a network failure', async () => {
    const rxnorm = failing(() => {
      throw new TypeError('no route')
    })

    await expect(rxnorm.resolve('Advil')).rejects.toBeInstanceOf(UpstreamError)
  })

  it('lists the ingredients of a single-ingredient RxCUI', async () => {
    expect(await client().ingredientsOf('5640')).toEqual([{ rxcui: '5640', name: 'ibuprofen' }])
  })

  it('lists the ingredients of a combination RxCUI', async () => {
    expect(await client().ingredientsOf('214181')).toEqual([
      { rxcui: '161', name: 'acetaminophen' },
      { rxcui: '3498', name: 'diphenhydramine' },
    ])
  })

  it('lists no ingredients for an unknown RxCUI', async () => {
    expect(await client().ingredientsOf('0')).toEqual([])
  })

  it('reads the display names', async () => {
    const names = await client().displayNames()

    expect(names).toContain('advil')
    expect(names).toContain('metFORMIN')
  })

  it('raises UpstreamError on malformed display names', async () => {
    const rxnorm = failing(() => json(200, { displayTermsList: { term: 'advil' } }))

    await expect(rxnorm.displayNames()).rejects.toBeInstanceOf(UpstreamError)
  })
})
