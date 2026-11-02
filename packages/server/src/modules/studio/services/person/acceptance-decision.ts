import type { PersonAcceptanceReport } from '../../contracts/person-acceptance'

/** A non-blocking label must not discard an unresolved product defect. */
export function normalizeBotAcceptanceDecision(value: unknown): PersonAcceptanceReport {
  const report=value as PersonAcceptanceReport
  if(!report || !Array.isArray(report.checks)) throw new Error('Acceptance decision requires per-criterion checks')
  const checks=report.checks.map(check=>{
    if(!check || !Array.isArray(check.issues) || check.issues.length>20) throw new Error('List product issues for every criterion; use an empty issues array when none remain')
    for(const issue of check.issues) {
      if(!issue || !['repair','resolved','out_of_scope'].includes(issue.disposition)
        || typeof issue.description!=='string' || !issue.description.trim() || issue.description.length>2000
        || typeof issue.reason!=='string' || !issue.reason.trim() || issue.reason.length>2000) throw new Error('Every issue needs a description, disposition and concrete reason')
    }
    return {...check,status:check.status!=='blocked'&&check.issues.some(issue=>issue.disposition==='repair')?'failed' as const:check.status}
  })
  const unresolved=checks.flatMap(check=>check.issues!.filter(issue=>issue.disposition==='repair'))
  if(unresolved.length && report.verdict==='passed') return {...report,checks,verdict:checks.some(check=>check.status==='blocked')?'blocked':'failed',summary:`Repair required: ${unresolved.map(issue=>issue.description).join('; ')}`.slice(0,4000)}
  return {...report,checks}
}
