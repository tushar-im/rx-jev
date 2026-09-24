import { useEffect, useState } from 'react'
import { AnswerCard } from './AnswerCard.tsx'
import { CustomQuestion } from './CustomQuestion.tsx'
import { ApiError, fetchAnswers, type AnswersResponse, type ResolvedDrug } from './api.ts'
import { PRODUCT_TYPE_TEXT } from './format.ts'
import { QuestionChips } from './QuestionChips.tsx'

const UNAVAILABLE = 'Answers are unavailable right now. Try again later.'

type State =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; data: AnswersResponse }

type Props = {
  drug: ResolvedDrug
}

// What each of the drug's labels says. Mount with `key={drug.rxcui}` so a new drug
// starts from a fresh state.
export function DrugAnswers({ drug }: Props): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [labelIndex, setLabelIndex] = useState(0)
  const [questionId, setQuestionId] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchAnswers(drug.rxcui, controller.signal)
      .then((data) => setState({ kind: 'loaded', data }))
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

  return (
    <div className="drug-answers">
      {labels.length > 1 && (
        <div role="group" aria-label="Label" className="label-switch">
          {labels.map((l, i) => (
            <button
              key={l.set_id}
              type="button"
              aria-pressed={l === label}
              onClick={() => setLabelIndex(i)}
            >
              {PRODUCT_TYPE_TEXT[l.product_type]}
            </button>
          ))}
        </div>
      )}
      <QuestionChips answers={label.answers} selected={questionId} onSelect={setQuestionId} />
      {answer ? (
        <AnswerCard label={label} answer={answer} />
      ) : (
        <p className="hint">Pick a question to see what the label says.</p>
      )}
      <CustomQuestion key={label.set_id} rxcui={drug.rxcui} label={label} />
    </div>
  )
}
