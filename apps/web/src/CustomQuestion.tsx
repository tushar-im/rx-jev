import { useEffect, useRef, useState } from 'react'
import { AnswerCard } from './AnswerCard.tsx'
import { ApiError, askLabel, type AskResponse, type LabelInfo } from './api.ts'

const UNAVAILABLE = 'Answers are unavailable right now. Try again later.'

type State =
  | { kind: 'idle' }
  | { kind: 'asking' }
  | { kind: 'failed'; message: string }
  | { kind: 'answered'; data: AskResponse }

type Props = {
  rxcui: string
  // The label on screen. Mount with `key={label.set_id}` so another label starts empty.
  label: LabelInfo
}

// A reader's own question about one label. Jev reads it live every time; the answer shows
// the same fixed categories and verbatim quote as the catalog questions.
export function CustomQuestion({ rxcui, label }: Props): React.JSX.Element {
  const [text, setText] = useState('')
  const [state, setState] = useState<State>({ kind: 'idle' })
  const inFlight = useRef<AbortController | null>(null)

  useEffect(() => () => inFlight.current?.abort(), [])

  function submit(event: React.SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    const question = text.trim()
    if (!question) return
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setState({ kind: 'asking' })
    askLabel(rxcui, label.set_id, question, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ kind: 'answered', data })
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return
        // A problem the reader can act on is passed on; anything else stays generic.
        const shown = e instanceof ApiError && [404, 422, 429].includes(e.problem.status)
        setState({ kind: 'failed', message: shown ? e.problem.detail : UNAVAILABLE })
      })
  }

  return (
    <div className="custom-question">
      <form aria-label="Ask your own question" onSubmit={submit}>
        <label htmlFor="custom-question-text">Your own question about this label</label>
        <div className="custom-question-row">
          <input
            id="custom-question-text"
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="For example: grapefruit juice"
            autoComplete="off"
          />
          <button type="submit" disabled={!text.trim() || state.kind === 'asking'}>
            Ask
          </button>
        </div>
      </form>
      {state.kind === 'asking' && (
        <p role="status" className="loading">
          Reading the label… This can take up to a minute.
        </p>
      )}
      {state.kind === 'failed' && <p role="alert">{state.message}</p>}
      {state.kind === 'answered' && (
        <AnswerCard label={state.data.label} answer={state.data.answer} />
      )}
    </div>
  )
}
