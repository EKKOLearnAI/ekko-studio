/** Group clarify payloads cross two untrusted Node boundaries: the browser socket that answers a
 * card and the Relay peer that asks it. Both sides are rebuilt here from scratch instead of being
 * forwarded, so a hostile peer can only ever produce the shapes the bridge already accepts. */

export interface ClarifyQuestionPayload {
    qid: string
    question: string
    choices: string[] | null
    multi_select: boolean
}

export type ClarifyAnswers = Record<string, string | string[] | null>

const MAX_QUESTIONS = 5
const MAX_CHOICES = 20
const MAX_QID_CHARS = 64
const MAX_QUESTION_CHARS = 20_000
const MAX_CHOICE_CHARS = 2_000
const MAX_ANSWER_CHARS = 8_000

/** The asked question list. Entries without question text are dropped and an empty list becomes
 * null, which leaves the client on the single `question` fallback. */
export function sanitizeClarifyQuestions(value: unknown): ClarifyQuestionPayload[] | null {
    if (!Array.isArray(value)) return null
    const questions = value.slice(0, MAX_QUESTIONS).map((entry, index) => {
        const source = entry && typeof entry === 'object' && !Array.isArray(entry)
            ? entry as Record<string, unknown>
            : {}
        const choices = Array.isArray(source.choices)
            ? source.choices.slice(0, MAX_CHOICES).map(choice => String(choice).slice(0, MAX_CHOICE_CHARS))
            : []
        return {
            qid: String(source.qid || `q${index}`).slice(0, MAX_QID_CHARS),
            question: String(source.question || '').slice(0, MAX_QUESTION_CHARS),
            choices: choices.length ? choices : null,
            multi_select: source.multi_select === true,
        }
    }).filter(question => question.question)
    return questions.length ? questions : null
}

/** The structured answer map keyed by question id. Anything outside the contract drops the whole
 * map so the caller falls back to the legacy single `response` string. An empty map is valid and
 * means the card was dismissed. */
export function sanitizeClarifyAnswers(value: unknown): ClarifyAnswers | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length > MAX_QUESTIONS) return undefined
    const answers: ClarifyAnswers = {}
    for (const [qid, answer] of entries) {
        if (!qid || qid.length > MAX_QID_CHARS) return undefined
        if (answer === null) answers[qid] = null
        else if (typeof answer === 'string') answers[qid] = answer.slice(0, MAX_ANSWER_CHARS)
        else if (!Array.isArray(answer) || answer.length > MAX_CHOICES) return undefined
        else if (answer.some(item => typeof item !== 'string')) return undefined
        else answers[qid] = (answer as string[]).map(item => item.slice(0, MAX_ANSWER_CHARS))
    }
    return answers
}
