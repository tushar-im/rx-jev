import { GROUPS, type Answer, type Group } from './api.ts'
import { visibleAnswers } from './questions.ts'

const GROUP_TITLES: Record<Group, string> = {
  who: 'Who is taking it',
  conditions: 'Health conditions',
  combinations: 'Taken with',
  daily_life: 'Daily life',
  serious: 'Serious warnings',
}

type Props = {
  answers: Answer[]
  selected: string | null
  onSelect: (questionId: string) => void
}

export function QuestionChips({ answers, selected, onSelect }: Props): React.JSX.Element {
  const visible = visibleAnswers(answers)
  return (
    <div className="question-chips">
      {GROUPS.map((group) => {
        const inGroup = visible.filter((a) => a.group === group)
        if (inGroup.length === 0) return null
        return (
          <div key={group} role="group" aria-label={GROUP_TITLES[group]} className="chip-group">
            <h3>{GROUP_TITLES[group]}</h3>
            <div className="chips">
              {inGroup.map((a) => (
                <button
                  key={a.question_id}
                  type="button"
                  className="chip"
                  aria-pressed={a.question_id === selected}
                  onClick={() => onSelect(a.question_id)}
                >
                  {a.title}
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
