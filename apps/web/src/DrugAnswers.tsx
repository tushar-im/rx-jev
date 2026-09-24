import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnswerCard } from './AnswerCard.tsx'
import { CustomQuestion } from './CustomQuestion.tsx'
import {
  ApiError,
  fetchAnswers,
  type AnswersResponse,
  type AskResponse,
  type ResolvedDrug,
} from './api.ts'
import { PRODUCT_TYPE_TEXT } from './format.ts'
import { QuestionChips } from './QuestionChips.tsx'
import { hasClearAnswer, visibleAnswers } from './questions.ts'
import { type Focus, type Session, TraceDetails } from './TracePanel.tsx'

const UNAVAILABLE = 'Answers are unavailable right now. Try again later.'

type State =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; data: AnswersResponse }

type Props = {
  drug: ResolvedDrug
  // Where to render the question chips, such as the page sidebar. Inline when absent.
  chipsSlot?: HTMLElement | null
  // Where to render "How this answer was made". Not rendered when absent.
  panelSlot?: HTMLElement | null
  // Told of the Jev usage behind each response, to add to the session totals.
  onUsage?: (usage: Session) => void
}

// What each of the drug's labels says. Mount with `key={drug.rxcui}` so a new drug
// starts from a fresh state.
export function DrugAnswers({ drug, chipsSlot, panelSlot, onUsage }: Props): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [labelIndex, setLabelIndex] = useState(0)
  const [questionId, setQuestionId] = useState<string | null>(null)
  // The latest answer to the reader's own question, and whether the panel describes it.
  const [custom, setCustom] = useState<AskResponse | null>(null)
  const [customFocus, setCustomFocus] = useState(false)
  const switchId = useId()
  // The latest onUsage, so a new callback from the parent never refetches the answers.
  const usage = useRef(onUsage)
  useEffect(() => {
    usage.current = onUsage
  })

  useEffect(() => {
    const controller = new AbortController()
    fetchAnswers(drug.rxcui, controller.signal)
      .then((data) => {
        // A fetch can still resolve after its abort; only the live request counts.
        if (controller.signal.aborted) return
        setState({ kind: 'loaded', data })
        usage.current?.(labelsUsage(data))
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return
        // A 404 says which drug has no label; other failures stay generic.
        const notFound = e instanceof ApiError && e.problem.status === 404
        setState({ kind: 'failed', message: notFound ? e.problem.detail : UNAVAILABLE })
      })
    return () => controller.abort()
  }, [drug.rxcui])

  if (state.kind === 'loading') {
    // A label read for the first time is judged by Jev, which can take a minute.
    return (
      <p role="status" className="loading">
        Reading the label… The first look at a label can take up to a minute.
      </p>
    )
  }
  if (state.kind === 'failed') return <p role="alert">{state.message}</p>

  const { labels } = state.data
  const label = labels[labelIndex] ?? labels[0]
  if (!label) return <p role="alert">No FDA label found for this drug.</p>
  const answer = label.answers.find((a) => a.question_id === questionId)
  const chips = (
    <QuestionChips
      answers={label.answers}
      selected={questionId}
      onSelect={(id) => {
        setQuestionId(id)
        setCustomFocus(false)
      }}
    />
  )
  const focus: Focus | null =
    customFocus && custom
      ? { kind: 'custom', data: custom }
      : answer
        ? { kind: 'catalog', answer }
        : null
  const trace = <TraceDetails sources={state.data.sources} label={label} focus={focus} />

  function showLabel(i: number): void {
    // Re-clicking the shown label changes nothing, so the custom answer stays with it.
    if (labels[i] === label) return
    setLabelIndex(i)
    setCustom(null)
  }

  // When this label has no clear answer but another label does, point to it. The pointer
  // says an answer exists there, never what it is.
  const otherIndex =
    answer && !hasClearAnswer(answer)
      ? labels.findIndex(
          (l) =>
            l !== label &&
            l.answers.some((a) => a.question_id === answer.question_id && hasClearAnswer(a)),
        )
      : -1
  const other = labels[otherIndex]

  return (
    <div className="drug-answers">
      {labels.length > 1 && (
        <div className="label-switch-wrap">
          <span id={switchId} className="switch-caption">
            Which label
          </span>
          <div role="group" aria-labelledby={switchId} className="label-switch">
            {labels.map((l, i) => {
              const clear = visibleAnswers(l.answers).filter(hasClearAnswer).length
              return (
                <button
                  key={l.set_id}
                  type="button"
                  aria-pressed={l === label}
                  aria-describedby={`${switchId}-${i}`}
                  onClick={() => showLabel(i)}
                >
                  {PRODUCT_TYPE_TEXT[l.product_type]}
                  {/* Just the number; the hover title and description say what it counts. */}
                  <span
                    className="switch-count"
                    aria-hidden="true"
                    title={`${clear} ${clear === 1 ? 'question' : 'questions'} with a clear answer`}
                  >
                    {clear}
                  </span>
                  <span id={`${switchId}-${i}`} hidden>
                    {clear} {clear === 1 ? 'question' : 'questions'} with a clear answer
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
      {chipsSlot ? createPortal(chips, chipsSlot) : chips}
      {answer ? (
        <div className="answer-stack">
          <AnswerCard label={label} answer={answer} />
          {other && (
            <p className="other-label">
              <span>
                The {PRODUCT_TYPE_TEXT[other.product_type].toLowerCase()} label answers this.
              </span>{' '}
              <button type="button" className="link-button" onClick={() => showLabel(otherIndex)}>
                Show the {PRODUCT_TYPE_TEXT[other.product_type].toLowerCase()} label
              </button>
            </p>
          )}
        </div>
      ) : (
        <p className="hint">Pick a question to see what the label says.</p>
      )}
      <CustomQuestion
        key={label.set_id}
        rxcui={drug.rxcui}
        label={label}
        onAnswered={(data) => {
          setCustom(data)
          setCustomFocus(data !== null)
          if (data) onUsage?.(askUsage(data))
        }}
      />
      {panelSlot && createPortal(trace, panelSlot)}
    </div>
  )
}

// Labels judged by this request used Jev; the rest came from the store.
function labelsUsage(data: AnswersResponse): Session {
  const fresh = data.labels.filter((l) => l.fresh)
  return {
    tokens: fresh.reduce((sum, l) => sum + (l.input_tokens ?? 0) + (l.output_tokens ?? 0), 0),
    live: fresh.length,
    // From the store: a run exists but was not made now. A label Jev was never asked about
    // (every question skipped) did not come from the store either.
    stored: data.labels.filter((l) => !l.fresh && l.model_version !== null).length,
  }
}

function askUsage(data: AskResponse): Session {
  const asked = data.answer.status === 'judged'
  return {
    tokens: (data.input_tokens ?? 0) + (data.output_tokens ?? 0),
    live: asked ? 1 : 0,
    stored: 0,
  }
}
