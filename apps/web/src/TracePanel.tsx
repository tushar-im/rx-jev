import type { Answer, AskResponse, LabelAnswers, SourceTrace } from './api.ts'
import { PRODUCT_TYPE_TEXT } from './format.ts'

// "How this answer was made": the numbers behind the answer on screen, for curious readers
// and demos. Guardrail: for an answer shown as "no clear answer" it never reveals the stance
// or a confidence, because that would show the top guess the card deliberately hides.

export type Focus = { kind: 'catalog'; answer: Answer } | { kind: 'custom'; data: AskResponse }

// Jev usage added up over this browser session.
export type Session = {
  tokens: number
  // Jev calls made for this session: labels judged now and custom questions.
  live: number
  // Labels served from the store without calling Jev.
  stored: number
}

const COUNT = new Intl.NumberFormat('en-US')
const DAY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' })

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

function plural(n: number, one: string, many: string): string {
  return `${COUNT.format(n)} ${n === 1 ? one : many}`
}

function sectionName(section: string): string {
  return section.replaceAll('_', ' ')
}

type Props = {
  sources: SourceTrace
  label: LabelAnswers
  focus: Focus | null
}

export function TraceDetails({ sources: labelSources, label, focus }: Props): React.JSX.Element {
  // A custom question made its own lookup; describe that one.
  const sources = focus?.kind === 'custom' ? focus.data.sources : labelSources
  const match = sources.matches[label.product_type]
  const type = PRODUCT_TYPE_TEXT[label.product_type].toLowerCase()
  return (
    <div className="trace">
      <section>
        <h3>The label</h3>
        {match &&
          (match.original_packager ? (
            <p>
              openFDA matched {COUNT.format(match.total)} original-packager {type} labels. This is
              the newest exact match.
            </p>
          ) : (
            // The fallback search is not filtered by packager, so its total counts them all.
            <p>
              openFDA matched {COUNT.format(match.total)} {type} labels. None from the original
              packager matched exactly, so this is the newest exact match from a repackager.
            </p>
          ))}
        <p className="trace-meta">
          {sources.openfda_stale ? (
            <>
              openFDA did not answer after {plural(sources.openfda_requests, 'search', 'searches')},
              so this is the lookup from{' '}
              {sources.openfda_fetched_at
                ? DAY.format(new Date(sources.openfda_fetched_at))
                : 'an earlier day'}
              .
            </>
          ) : sources.openfda_cached ? (
            <>openFDA lookup from the cache, made in the last 24 hours.</>
          ) : (
            <>
              {plural(sources.openfda_requests, 'openFDA search', 'openFDA searches')} in{' '}
              {seconds(sources.openfda_ms)}.
            </>
          )}{' '}
          RxNorm in {seconds(sources.rxnorm_ms)}.
        </p>
      </section>
      {focus && <AnswerTrace focus={focus} />}
      {focus?.kind === 'custom' ? (
        <section>
          <h3>Jev</h3>
          <p>
            Asked live
            {focus.data.input_tokens !== null && (
              <>: {tokens(focus.data.input_tokens, focus.data.output_tokens)} tokens</>
            )}
            {focus.data.latency_ms !== null && <> in {seconds(focus.data.latency_ms)}</>}. Your own
            questions are never stored.
          </p>
        </section>
      ) : (
        <LabelRun label={label} />
      )}
    </div>
  )
}

function AnswerTrace({ focus }: { focus: Focus }): React.JSX.Element {
  const answer = focus.kind === 'catalog' ? focus.answer : focus.data.answer
  if (answer.status !== 'judged') {
    return (
      <section>
        <h3>This answer</h3>
        <p>
          {answer.status === 'no_sections'
            ? 'This label has no section about it, so Jev was not asked.'
            : 'The sections to read were too long for one Jev request, so Jev was not asked.'}
        </p>
      </section>
    )
  }
  const from = answer.sections.map(sectionName).join(', ')
  const read = plural(answer.candidates, 'sentence', 'sentences')
  // Only a shown answer says Jev picked a sentence; a hidden one names no pick, no stance
  // and no confidence.
  if (answer.confident && answer.stance && answer.evidence?.quote) {
    return (
      <section>
        <h3>This answer</h3>
        <p>
          Jev picked 1 of {read} from {from}. It picks the label's own words and never writes new
          ones.
        </p>
        <p className="trace-meta">
          Confidence: stance {Math.round(answer.stance.confidence * 100)}%, quote{' '}
          {Math.round(answer.evidence.confidence * 100)}%.
        </p>
      </section>
    )
  }
  return (
    <section>
      <h3>This answer</h3>
      <p>
        Jev read {read} from {from}.
      </p>
      <p className="trace-meta">Below the display threshold, so no category is shown.</p>
    </section>
  )
}

function LabelRun({ label }: { label: LabelAnswers }): React.JSX.Element | null {
  // No model version means Jev was never asked about this label.
  if (label.model_version === null) return null
  const used = label.input_tokens === null ? null : tokens(label.input_tokens, label.output_tokens)
  return (
    <section>
      <h3>Jev</h3>
      {label.fresh ? (
        <p>
          Judged just now{used !== null && <>: {used} tokens</>}
          {label.latency_ms !== null && <> in {seconds(label.latency_ms)}</>}. Stored for next time.
        </p>
      ) : (
        <p>
          Served from the store, so no Jev call now. Judged
          {label.judged_at && <> {DAY.format(new Date(label.judged_at))}</>} with{' '}
          {label.model_version}
          {used !== null && <>: {used} tokens</>}.
        </p>
      )}
    </section>
  )
}

function tokens(input: number, output: number | null): string {
  return COUNT.format(input + (output ?? 0))
}

export function SessionTotals({ session }: { session: Session }): React.JSX.Element {
  return (
    <section className="session">
      <h3>This session</h3>
      <p className="session-tokens">{COUNT.format(session.tokens)}</p>
      <p className="trace-meta">
        Jev tokens. {plural(session.live, 'live Jev call', 'live Jev calls')},{' '}
        {plural(session.stored, 'label', 'labels')} from the store.
      </p>
    </section>
  )
}

export function HowItWorks(): React.JSX.Element {
  return (
    <ol className="how-it-works">
      <li>RxNorm turns the name you type into its ingredients.</li>
      <li>openFDA finds the official label, one per product type.</li>
      <li>
        TypeSafe Jev reads the label's sections and picks the sentence that answers the question. It
        picks the label's own words and never writes new ones.
      </li>
      <li>A category shows only when Jev is at least 90% sure of both the stance and the quote.</li>
    </ol>
  )
}
