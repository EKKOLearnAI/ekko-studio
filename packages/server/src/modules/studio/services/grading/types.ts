export interface Word { text: string; cx: number; cy: number; w: number; h: number; angle: number }
export type Box = [number, number, number, number]
export interface Question { qid: string; bbox: Box; wordRange: [number, number]; text: string; fullMark: number }
export type DiffOp = { type: 'delete' | 'mark'; range: [number, number]; mark?: 'circle' | 'underline' | 'cross' } | { type: 'insert'; after: number; text: string } | { type: 'comment' | 'badge'; text?: string; content?: string }
export interface GradeResult { qid: string; score: number; fullMark: number; feedback: string; confidence: number; diffOps: DiffOp[] }
export interface Annotation { id: string; kind: string; bbox: Box; content: string; color?: string; width?: number; points?: number[]; fontFamily?: string; solid?: boolean }
export interface Submission { id: string; examId: string; studentName: string; image: string; width: number; height: number; words: Word[]; questions: Question[]; results: GradeResult[]; annotations: Annotation[]; status: string; error: string; revision: number }
