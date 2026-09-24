import { describe, expect, it } from 'vitest'
import {
  dailymedUrl,
  matchesIngredients,
  OpenFdaClient,
  PAGE_SIZE,
} from '../../src/clients/openfda.ts'
import { UpstreamError } from '../../src/problems.ts'
import { json, mockFetch, openfdaFetch } from '../recorded.ts'

const BASE = 'https://fda.test'
const NOT_FOUND = { error: { code: 'NOT_FOUND' } }

function client(): OpenFdaClient {
  return new OpenFdaClient({ baseUrl: BASE, fetch: openfdaFetch() })
}

function makeClient(
  handler: (url: URL) => Response | Promise<Response>,
  apiKey: string | null = null,
): OpenFdaClient {
  return new OpenFdaClient({ baseUrl: BASE, fetch: mockFetch(handler) }, apiKey)
}

function fakeLabel(
  setId: string,
  substances: string[],
  original = true,
  applicationNumber: string[] = ['M013'],
): Record<string, unknown> {
  return {
    set_id: setId,
    version: '1',
    effective_time: '20260101',
    openfda: {
      product_type: ['HUMAN OTC DRUG'],
      substance_name: substances,
      brand_name: ['Brand'],
      manufacturer_name: ['Maker'],
      is_original_packager: [original],
      application_number: applicationNumber,
    },
    warnings: ['Line one.', 'Line two.'],
  }
}

function params(url: URL): { search: string; skip: number; limit: number } {
  return {
    search: url.searchParams.get('search') ?? '',
    skip: Number(url.searchParams.get('skip')),
    limit: Number(url.searchParams.get('limit')),
  }
}

function otcOnly(results: Record<string, unknown>[]): (url: URL) => Response {
  return (url) => {
    const { search, skip, limit } = params(url)
    if (!search.includes('HUMAN OTC DRUG')) return json(404, NOT_FOUND)
    return json(200, { results: results.slice(skip, skip + limit) })
  }
}

describe('OpenFdaClient', () => {
  it('skips labels without an application number', async () => {
    // Homeopathic products carry no NDA, ANDA, BLA or monograph number, and are not the drug.
    const results = [
      fakeLabel('homeopathic', ['CITALOPRAM'], true, []),
      fakeLabel('approved', ['CITALOPRAM HYDROBROMIDE'], true, ['ANDA077031']),
    ]
    const labels = await makeClient(otcOnly(results)).canonicalLabels(['citalopram'])

    expect(labels.otc?.set_id).toBe('approved')
  })

  it('finds nothing when only labels without an application number match', async () => {
    const results = [fakeLabel('homeopathic', ['LEVOTHYROXINE'], true, [])]
    const labels = await makeClient(otcOnly(results)).canonicalLabels(['levothyroxine'])

    expect(labels.otc).toBeNull()
  })

  it('returns one label per type for a drug with both', async () => {
    const labels = await client().canonicalLabels(['ibuprofen'])

    expect(labels.otc?.set_id).toBe('0ca02f8b-4413-4e7c-a67b-8c67c53e1343')
    expect(labels.otc?.product_type).toBe('otc')
    expect(labels.otc?.effective_time).toBe('2026-09-09')
    expect(labels.otc?.is_original_packager).toBe(true)
    expect(labels.prescription?.set_id).toBe('3e131710-2579-446e-8076-f602ecea813f')
    expect(labels.prescription?.product_type).toBe('prescription')
  })

  it('keeps sections, the version and a DailyMed link', async () => {
    const label = (await client().canonicalLabels(['ibuprofen'])).otc

    expect(label?.version).toBe('5')
    expect(label?.sections.do_not_use?.trim()).not.toBe('')
    expect(Object.keys(label?.sections ?? {}).some((name) => name.endsWith('_table'))).toBe(false)
    expect(label && dailymedUrl(label)).toBe(
      'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0ca02f8b-4413-4e7c-a67b-8c67c53e1343',
    )
  })

  it('skips combination labels with extra ingredients', async () => {
    const labels = await client().canonicalLabels(['acetaminophen', 'diphenhydramine'])

    expect(labels.otc?.set_id).toBe('923b443d-73cc-4c52-92e4-a075786b1ae3')
    expect(labels.prescription).toBeNull()
  })

  it('matches salt forms and returns null for a missing type', async () => {
    const labels = await client().canonicalLabels(['metformin'])

    expect(labels.otc).toBeNull()
    expect(labels.prescription?.set_id).toBe('7cc02a26-5c22-445b-ad8f-3e7570c143d3')
    expect(labels.prescription?.substance_names).toEqual(['METFORMIN HYDROCHLORIDE'])
  })

  it('falls back to repackagers when there is no original packager label', async () => {
    const labels = await client().canonicalLabels(['loratadine'])

    expect(labels.prescription?.set_id).toBe('0d74af21-3ef7-418b-a2ef-78737b0af288')
    expect(labels.prescription?.is_original_packager).toBe(false)
  })

  it('pages until an exact match is found', async () => {
    const skips: number[] = []
    const labels = await makeClient((url) => {
      const { search, skip } = params(url)
      skips.push(skip)
      if (!search.includes('HUMAN OTC DRUG')) return json(404, NOT_FOUND)
      if (skip === 0) {
        const combos = [0, 1, 2, 3, 4].map((n) =>
          fakeLabel(`combo-${n}`, ['IBUPROFEN', 'FAMOTIDINE']),
        )
        return json(200, { results: combos })
      }
      return json(200, { results: [fakeLabel('single', ['IBUPROFEN'])] })
    }).canonicalLabels(['ibuprofen'])

    expect(labels.otc?.set_id).toBe('single')
    expect(skips).toContain(0)
    expect(skips).toContain(PAGE_SIZE)
  })

  it('joins the items of a section verbatim', async () => {
    const labels = await makeClient((url) => {
      if (!params(url).search.includes('HUMAN OTC DRUG')) return json(404, NOT_FOUND)
      return json(200, { results: [fakeLabel('s', ['IBUPROFEN'])] })
    }).canonicalLabels(['ibuprofen'])

    expect(labels.otc?.sections).toEqual({ warnings: 'Line one.\n\nLine two.' })
  })

  it('sends the API key when configured', async () => {
    const keys: (string | null)[] = []
    await makeClient((url) => {
      keys.push(url.searchParams.get('api_key'))
      return json(404, NOT_FOUND)
    }, 'k123').canonicalLabels(['ibuprofen'])

    expect(keys.length).toBeGreaterThan(0)
    expect(keys.every((k) => k === 'k123')).toBe(true)
  })

  it('raises UpstreamError on a server error', async () => {
    const openfda = makeClient(() => new Response('boom', { status: 500 }))

    await expect(openfda.canonicalLabels(['ibuprofen'])).rejects.toBeInstanceOf(UpstreamError)
  })

  it('raises UpstreamError on a malformed payload', async () => {
    const openfda = makeClient(() => json(200, { results: [{ set_id: 5 }] }))

    await expect(openfda.canonicalLabels(['ibuprofen'])).rejects.toBeInstanceOf(UpstreamError)
  })

  it('rejects an empty ingredient list', async () => {
    await expect(client().canonicalLabels([])).rejects.toThrow()
  })

  it('keeps paging with growing pages until results run out', async () => {
    const combos = Array.from({ length: 60 }, (_, n) =>
      fakeLabel(`combo-${n}`, ['IBUPROFEN', 'FAMOTIDINE']),
    )
    const results = [...combos, fakeLabel('late-single', ['IBUPROFEN'])]
    const limits: number[] = []
    const labels = await makeClient((url) => {
      const { search, skip, limit } = params(url)
      if (!search.includes('HUMAN OTC DRUG') || !search.includes('is_original_packager')) {
        return json(404, NOT_FOUND)
      }
      limits.push(limit)
      return json(200, { results: results.slice(skip, skip + limit) })
    }).canonicalLabels(['ibuprofen'])

    expect(labels.otc?.set_id).toBe('late-single')
    expect(labels.otc?.is_original_packager).toBe(true)
    expect(limits).toEqual([5, 25, 100])
  })

  it('falls back and then finds nothing when no result matches exactly', async () => {
    const combos = Array.from({ length: 40 }, (_, n) =>
      fakeLabel(`combo-${n}`, ['IBUPROFEN', 'FAMOTIDINE']),
    )
    const labels = await makeClient(otcOnly(combos)).canonicalLabels(['ibuprofen'])

    expect(labels.otc).toBeNull()
  })

  it('reports how many labels each search matched', async () => {
    const labels = await client().canonicalLabels(['ibuprofen'])

    expect(labels.matches).toEqual({
      otc: { total: 831, original_packager: true },
      prescription: { total: 47, original_packager: true },
    })
    expect(labels.requests).toBe(2)
  })

  it('counts every search, empty ones included', async () => {
    const labels = await client().canonicalLabels(['metformin'])

    // No OTC label at all: two empty searches, then the prescription one.
    expect(labels.matches).toEqual({ prescription: { total: 124, original_packager: true } })
    expect(labels.requests).toBe(3)
  })

  it('does not report a repackager match as an original packager match', async () => {
    const labels = await client().canonicalLabels(['loratadine'])

    expect(labels.matches.prescription?.original_packager).toBe(false)
    expect(labels.matches.prescription?.total).toBeGreaterThanOrEqual(1)
  })
})

describe('matchesIngredients', () => {
  it.each([
    [['IBUPROFEN'], ['ibuprofen'], true],
    [['IBUPROFEN SODIUM'], ['ibuprofen'], true],
    [['IBUPROFEN', 'FAMOTIDINE'], ['ibuprofen'], false],
    [['IBUPROFENOL'], ['ibuprofen'], false],
    [['ACETAMINOPHEN', 'DIPHENHYDRAMINE CITRATE'], ['diphenhydramine', 'acetaminophen'], true],
    [['ACETAMINOPHEN', 'ACETAMINOPHEN'], ['acetaminophen', 'diphenhydramine'], false],
    [[], ['ibuprofen'], false],
  ])('%j against %j is %s', (substances, ingredients, expected) => {
    expect(matchesIngredients(substances, ingredients)).toBe(expected)
  })
})
