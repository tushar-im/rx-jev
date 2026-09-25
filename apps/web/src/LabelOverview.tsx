import { useId, useState } from 'react'
import type { LabelAnswers, LabelOverview, LabelText } from './api.ts'
import { PRODUCT_TYPE_TEXT } from './format.ts'
import { hasClearAnswer, visibleAnswers } from './questions.ts'

// The label itself, shown until a question is picked: its boxed warning, what it is for and
// its strengths, each one whole section word for word, then which questions it answers
// clearly. Guardrail: the overview never shows what an answer says. A category is only
// shown on its card, next to its quote and provenance.

const SECTION_NAMES: Record<string, string> = {
  boxed_warning: 'Boxed warning',
  purpose: 'Purpose',
  indications_and_usage: 'Indications and usage',
  dosage_forms_and_strengths: 'Dosage forms and strengths',
  active_ingredient: 'Active ingredient',
}

// Sections longer than this start collapsed; the full text stays on the page.
const LONG_CHARS = 600

const NO_OVERVIEW: LabelOverview = {
  boxed_warning: null,
  purpose: null,
  uses: null,
  strengths: null,
}

const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' })

type Props = {
  label: LabelAnswers
  onPick: (questionId: string) => void
}

export function LabelOverview({ label, onPick }: Props): React.JSX.Element {
  // The Python reference API sends no overview; then only the grid is shown.
  const { boxed_warning, purpose, uses, strengths } = label.overview ?? NO_OVERVIEW
  // Keyed by label and section, so another label's sections always start collapsed.
  const key = (text: LabelText): string => `${label.set_id}:${text.section}`
  return (
    <div className="label-overview">
      <p className="overview-source">
        {PRODUCT_TYPE_TEXT[label.product_type]} label
        {label.manufacturer_name && <> from {label.manufacturer_name}</>}, version {label.version},
        effective {DATE.format(new Date(label.effective_time))}. Quoted word for word.{' '}
        <a href={label.dailymed_url} target="_blank" rel="noreferrer">
          Read the full label on DailyMed
        </a>
      </p>
      {boxed_warning && <LabelSection key={key(boxed_warning)} text={boxed_warning} boxed />}
      {purpose && <LabelSection key={key(purpose)} text={purpose} />}
      {uses && <LabelSection key={key(uses)} text={uses} />}
      {strengths && <LabelSection key={key(strengths)} text={strengths} />}
      <ClearAnswers label={label} onPick={onPick} />
    </div>
  )
}

function LabelSection({
  text,
  boxed = false,
}: {
  text: LabelText
  boxed?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const textId = useId()
  const name = SECTION_NAMES[text.section] ?? text.section.replaceAll('_', ' ')
  const long = text.text.length > LONG_CHARS
  const body = (
    <>
      <h3>{name}</h3>
      <p id={textId} className="label-text" data-collapsed={long && !expanded}>
        {text.text}
      </p>
      {long && (
        <button
          type="button"
          className="link-button"
          aria-expanded={expanded}
          aria-controls={textId}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? 'Show less' : 'Show all'}
        </button>
      )}
    </>
  )
  return boxed ? (
    <section role="note" aria-label={name} className="label-section boxed-warning">
      {body}
    </section>
  ) : (
    <section className="label-section">{body}</section>
  )
}

// Which questions the label answers clearly, in one line. The sidebar chips already list
// every question, so this names only the clear ones, as links to their cards.
function ClearAnswers({ label, onPick }: Props): React.JSX.Element {
  const clear = visibleAnswers(label.answers).filter(hasClearAnswer)
  return (
    <section aria-label="Clear answers" className="clear-answers">
      {clear.length === 0 ? (
        <p>
          This label has no clear answer to the standard questions. Pick one in the sidebar to see
          what we found, or ask your own question below.
        </p>
      ) : (
        <p>
          This label clearly answers {clear.length} {clear.length === 1 ? 'question' : 'questions'}:{' '}
          {clear.map((a, i) => (
            <span key={a.question_id}>
              {i > 0 && ', '}
              <button
                type="button"
                className="link-button"
                // Named apart from the sidebar chip of the same question.
                aria-label={`${a.title}: show what the label says`}
                onClick={() => onPick(a.question_id)}
              >
                {a.title}
              </button>
            </span>
          ))}
          . Pick any question in the sidebar to see what the label says.
        </p>
      )}
    </section>
  )
}
