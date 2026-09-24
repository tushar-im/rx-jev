import type { Answer, LabelAnswers, Quote, Stance } from './api.ts'
import { PRODUCT_TYPE_TEXT } from './format.ts'

// Category names say what the label does, never whether a drug is safe for anyone.
const STANCE_TEXT: Record<Stance, string> = {
  warns_against: 'The label warns against use',
  caution: 'The label advises caution',
  dose_change: 'The label gives a different dose',
  no_known_issue: 'The label says no problem is known',
  not_mentioned: 'The label does not mention this',
}

const NO_CLEAR_ANSWER = "We couldn't find a clear answer. Read the full label or ask a pharmacist."
const NO_SECTION = 'This label has no section about this. Read the full label or ask a pharmacist.'

const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' })

type Props = {
  label: LabelAnswers
  answer: Answer
}

export function AnswerCard({ label, answer }: Props): React.JSX.Element {
  const quote = answer.evidence?.quote ?? null
  // Only an answer the API marks confident shows a category, and it always has a quote.
  const shown = answer.confident && answer.stance && quote ? { stance: answer.stance.choice, quote } : null

  return (
    <article className="answer-card" aria-live="polite">
      <h3>What the label says about {answer.title.toLowerCase()}</h3>
      {shown ? (
        <Finding stance={shown.stance} quote={shown.quote} />
      ) : (
        <p className="no-answer">{answer.status === 'no_sections' ? NO_SECTION : NO_CLEAR_ANSWER}</p>
      )}
      <footer>
        <p className="provenance">
          {label.brand_name ?? PRODUCT_TYPE_TEXT[label.product_type]} label, version {label.version},
          effective {DATE.format(new Date(label.effective_time))}.{' '}
          <a href={label.dailymed_url} target="_blank" rel="noreferrer">
            Read the full label on DailyMed
          </a>
        </p>
        {!answer.reviewed && <p className="unreviewed">Not yet checked by a pharmacist.</p>}
        <p className="pharmacist">Ask your pharmacist about your own situation.</p>
      </footer>
    </article>
  )
}

function Finding({ stance, quote }: { stance: Stance; quote: Quote }): React.JSX.Element {
  return (
    <>
      <p className="stance" data-stance={stance}>
        <span className="stance-icon" aria-hidden="true" />
        {STANCE_TEXT[stance]}
      </p>
      <blockquote>
        {quote.lead_in && <>{quote.lead_in} </>}
        {quote.text}
      </blockquote>
      <p className="section">From the label section: {sectionName(quote.section)}</p>
    </>
  )
}

function sectionName(section: string): string {
  const words = section.replaceAll('_', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
