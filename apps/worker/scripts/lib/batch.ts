import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ProductType, SkipReason } from '@rx-jev/contract'
import { judgeLabels } from '../../src/answering.ts'
import type { Label, OpenFdaClient } from '../../src/clients/openfda.ts'
import type { RxNormClient } from '../../src/clients/rxnorm.ts'
import type { Judge } from '../../src/judge.ts'
import { JudgeError, UpstreamError } from '../../src/problems.ts'
import type { Store } from '../../src/store.ts'

// Precomputes stored judgments for a list of drug names, such as the Gate 1 review set.
//
// Each drug is resolved through RxNorm, its canonical labels fetched from openFDA, and every
// label the store lacks is judged. A failing drug is reported and the batch moves on.
// Re-running the batch only calls Jev for labels whose version, prompt or model changed.

export type DrugStatus = 'ok' | 'not_found' | 'no_label' | 'upstream_failed' | 'jev_failed'

export type LabelReport = {
  set_id: string
  version: string
  product_type: ProductType
  fresh: boolean
  // Null when no question had candidates, so the label has no stored run.
  model_version: string | null
  latency_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
  skipped: Record<string, SkipReason>
}

export type DrugReport = {
  name: string
  status: DrugStatus
  rxcui: string | null
  labels: LabelReport[]
  error: string | null
}

/**
 * Replaces the report atomically, so an interrupted run never leaves partial JSON: the JSON
 * goes to a temporary file in the same folder, which is then renamed over the report.
 */
export function writeReport(
  path: string,
  reports: DrugReport[],
  rename: (from: string, to: string) => void = renameSync,
): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(tmp, `${JSON.stringify(reports, null, 2)}\n`, { flush: true })
    rename(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

/**
 * Labels whose stored run came from a Jev version other than the one Gate 1 validated. Runs
 * are keyed by the requested model name, so a new version behind `jev-latest` only reaches
 * labels judged after it ships. Those answers need the thresholds re-checked.
 */
export function unvalidatedLabels(reports: DrugReport[], validatedVersion: string): string[] {
  return reports.flatMap((report) =>
    report.labels
      .filter((l) => l.model_version !== null && l.model_version !== validatedVersion)
      .map((l) => `${report.name} (${l.product_type}, ${l.model_version})`),
  )
}

/** Drug names, one per line. Blank lines, `#` comments and repeats are dropped. */
export function readNames(text: string): string[] {
  const names = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const name = (line.split('#', 1)[0] ?? '').trim()
    if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name)
  }
  return [...names.values()]
}

export async function precompute(
  names: string[],
  rxnorm: RxNormClient,
  openfda: OpenFdaClient,
  judge: Judge,
  store: Store,
): Promise<DrugReport[]> {
  const reports: DrugReport[] = []
  for (const name of names) reports.push(await precomputeOne(name, rxnorm, openfda, judge, store))
  return reports
}

function report(name: string, status: DrugStatus, extra: Partial<DrugReport> = {}): DrugReport {
  return { name, status, rxcui: null, labels: [], error: null, ...extra }
}

export async function precomputeOne(
  name: string,
  rxnorm: RxNormClient,
  openfda: OpenFdaClient,
  judge: Judge,
  store: Store,
): Promise<DrugReport> {
  let resolution: Awaited<ReturnType<RxNormClient['resolve']>>
  let labels: Label[]
  try {
    resolution = await rxnorm.resolve(name)
    if (resolution === null) return report(name, 'not_found')
    const canonical = await openfda.canonicalLabels(resolution.ingredients.map((i) => i.name))
    labels = [canonical.otc, canonical.prescription].filter((l): l is Label => l !== null)
  } catch (error) {
    if (error instanceof UpstreamError) {
      return report(name, 'upstream_failed', { error: error.message })
    }
    throw error
  }
  const rxcui = resolution.rxcui
  if (labels.length === 0) return report(name, 'no_label', { rxcui })

  try {
    const judged = await judgeLabels(labels, judge, store)
    return report(name, 'ok', {
      rxcui,
      labels: judged.map((j) => ({
        set_id: j.label.set_id,
        version: j.label.version,
        product_type: j.label.product_type,
        fresh: j.fresh,
        model_version: j.run?.model_version ?? null,
        latency_ms: j.run?.latency_ms ?? null,
        input_tokens: j.run?.input_tokens ?? null,
        output_tokens: j.run?.output_tokens ?? null,
        skipped: j.request.skipped as Record<string, SkipReason>,
      })),
    })
  } catch (error) {
    if (error instanceof JudgeError) {
      const cause = error.cause instanceof Error ? `: ${error.cause.message}` : ''
      return report(name, 'jev_failed', { rxcui, error: `${error.message}${cause}` })
    }
    throw error
  }
}
