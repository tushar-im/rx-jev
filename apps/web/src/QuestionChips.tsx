import { useId } from 'react'
import { type Answer, GROUPS } from './api.ts'
import { GROUP_TITLES, hasClearAnswer, visibleAnswers } from './questions.ts'

type Props = {
  answers: Answer[]
  selected: string | null
  onSelect: (questionId: string) => void
}

export function QuestionChips({ answers, selected, onSelect }: Props): React.JSX.Element {
  const visible = visibleAnswers(answers)
  const noteId = useId()
  const anyClear = visible.some(hasClearAnswer)
  return (
    <div className="question-chips-wrap">
      {anyClear && (
        <p id={noteId} className="chips-note">
          Highlighted questions have a clear answer on this label.
        </p>
      )}
      <div className="question-chips">
        {GROUPS.map((group) => {
          const inGroup = visible.filter((a) => a.group === group)
          if (inGroup.length === 0) return null
          return (
            <div key={group} role="group" aria-label={GROUP_TITLES[group]} className="chip-group">
              <h3>{GROUP_TITLES[group]}</h3>
              <div className="chips">
                {inGroup.map((a) => {
                  // Marks only that the label answers it clearly, never which way: every
                  // category looks the same.
                  const clear = hasClearAnswer(a)
                  return (
                    <button
                      key={a.question_id}
                      type="button"
                      className="chip"
                      data-clear={clear}
                      aria-describedby={clear ? noteId : undefined}
                      aria-pressed={a.question_id === selected}
                      onClick={() => onSelect(a.question_id)}
                    >
                      {a.title}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
