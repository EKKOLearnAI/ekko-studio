export interface ClarifyQuestion {
  qid: string
  question: string
  choices: string[] | null
  multiSelect: boolean
}

export type ClarifyAnswers = Record<string, string | string[] | null>

export interface ClarifyDraft {
  choices: string[]
  text: string
}

/** The clarify card always renders a question list: the bridge sends one per clarify tool
 * question, older runtimes and non-Hermes agents only send a single question plus choices. */
export function normalizeClarifyQuestions(
  raw: unknown,
  question: string,
  choices: string[] | null,
): ClarifyQuestion[] {
  const entries = Array.isArray(raw) ? raw : []
  const questions = entries.map((entry: unknown, index: number) => {
    const source = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
    const entryChoices = Array.isArray(source.choices) ? source.choices.map(String) : []
    return {
      qid: String(source.qid || `q${index}`),
      question: String(source.question || ''),
      choices: entryChoices.length ? entryChoices : null,
      multiSelect: Boolean(source.multi_select),
    }
  }).filter(entry => entry.question)
  if (questions.length) return questions
  return [{
    qid: 'q0',
    question: String(question || ''),
    choices: choices?.length ? choices.map(String) : null,
    multiSelect: false,
  }]
}

/** One answer: the typed "Other" text wins for single-select and joins the picked choices for
 * multi-select; nothing picked or typed means the question was skipped. */
export function clarifyAnswerOf(question: ClarifyQuestion, draft?: ClarifyDraft): string | string[] | null {
  const text = (draft?.text || '').trim()
  const picked = (draft?.choices || []).filter(choice => question.choices?.includes(choice))
  if (question.multiSelect) {
    const values = text ? [...picked, text] : picked
    return values.length ? values : null
  }
  return text || picked[0] || null
}

/** Structured answers for the clarify tool plus the legacy single-string response older
 * consumers (MCP clarifications, coding agents, group chat) still read. */
export function buildClarifySubmission(
  questions: ClarifyQuestion[],
  drafts: Record<string, ClarifyDraft | undefined>,
): { response: string; answers: ClarifyAnswers } {
  const answers: ClarifyAnswers = {}
  for (const question of questions) answers[question.qid] = clarifyAnswerOf(question, drafts[question.qid])
  const lines = questions
    .filter(question => answers[question.qid] !== null)
    .map((question) => {
      const answer = answers[question.qid]
      const text = Array.isArray(answer) ? answer.join(', ') : answer || ''
      return questions.length === 1 ? text : `${question.question} ${text}`
    })
  return { response: lines.join('\n'), answers }
}
