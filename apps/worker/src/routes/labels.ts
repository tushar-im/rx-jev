import type { LabelInfo, LabelsResponse, LabelView } from '@rx-jev/contract'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app.ts'
import { CATALOG, candidateSections, labelFormat } from '../catalog.ts'
import { dailymedUrl, type Label } from '../clients/openfda.ts'
import { canonicalLabels } from '../lookup.ts'
import { parseOr422 } from '../problems.ts'
import { splitSection } from '../sentences.ts'

// An RxNorm concept ID, as the answers and ask routes take it too.
export const RxCuiParams = z.object({ rxcui: z.string().regex(/^\d{1,12}$/) })

export function labelInfo(label: Label): LabelInfo {
  return {
    set_id: label.set_id,
    version: label.version,
    effective_time: label.effective_time,
    product_type: label.product_type,
    layout: labelFormat(label),
    brand_name: label.brand_name,
    manufacturer_name: label.manufacturer_name,
    dailymed_url: dailymedUrl(label),
  }
}

function view(label: Label): LabelView {
  const questions = CATALOG.map((q) => ({
    id: q.id,
    group: q.group,
    title: q.title,
    sections: candidateSections(q.id, label),
  }))
  const referenced = [...new Set(questions.flatMap((q) => q.sections))]
  return {
    ...labelInfo(label),
    questions,
    sections: Object.fromEntries(
      referenced.map((name) => [
        name,
        splitSection(name, label.sections[name] ?? '').map((c) => ({
          id: c.id,
          text: c.text,
          lead_in: c.lead_in?.text ?? null,
        })),
      ]),
    ),
  }
}

export const labelRoutes = new Hono<AppEnv>().get('/:rxcui', async (c) => {
  const { rxcui } = parseOr422(RxCuiParams, c.req.param(), 'path')
  const { rxnorm, openfda } = c.var.services
  const lookup = await canonicalLabels(rxcui, rxnorm, openfda)
  return c.json<LabelsResponse>({
    rxcui,
    ingredients: lookup.ingredients,
    labels: lookup.labels.map(view),
  })
})
