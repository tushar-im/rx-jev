import { useId, useState } from 'react'
import { GROUPS, type LabelAnswers, type LabelText } from './api.ts'
import { PRODUCT_TYPE_TEXT } from './format.ts'
import { GROUP_TITLES, hasClearAnswer, visibleAnswers } from './questions.ts'

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

const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' })

type Props = {
  label: LabelAnswers
  onPick: (questionId: string) => void
}

export function LabelOverview({ label, onPick }: Props): React.JSX.Element {
  const { boxed_warning, purpose, uses, strengths } = label.overview
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
      {boxed_warning && <LabelSection text={boxed_warning} boxed />}
      {purpose && <LabelSection text={purpose} />}
      {uses && <LabelSection text={uses} />}
      {strengths && <LabelSection text={strengths} />}
      <AtAGlance label={label} onPick={onPick} />
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
        {text.text.trim()}
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

function AtAGlance({ label, onPick }: Props): React.JSX.Element {
  const headingId = useId()
  const visible = visibleAnswers(label.answers)
  return (
    <section aria-labelledby={headingId} className="at-a-glance">
      <h3 id={headingId}>At a glance</h3>
      <p className="glance-note">
        Which questions this label answers clearly. Pick one to see the sentence.
      </p>
      {GROUPS.map((group) => {
        const inGroup = visible.filter((a) => a.group === group)
        if (inGroup.length === 0) return null
        return (
          <div key={group} className="glance-group">
            <h4>{GROUP_TITLES[group]}</h4>
            <ul>
              {inGroup.map((a) => {
                // Says only whether the answer is clear, never which way it goes. The boxed
                // warning, when the label has one, is already quoted in full above.
                const clear = hasClearAnswer(a)
                const above =
                  a.question_id === 'boxed_warning' && label.overview.boxed_warning !== null
                const status = above ? 'Shown above' : clear ? 'Clear answer' : 'No clear answer'
                return (
                  <li key={a.question_id}>
                    <button
                      type="button"
                      className="glance-item"
                      data-clear={clear || above}
                      onClick={() => onPick(a.question_id)}
                    >
                      <span>{a.title}</span>
                      <span className="glance-status">{status}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </section>
  )
}
