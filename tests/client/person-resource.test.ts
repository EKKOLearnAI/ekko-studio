import { expect, it } from 'vitest'
import { defaultPersonResource } from '../../packages/client/src/utils/person-resource'
it('ignores deleted directories and prefers default models',()=>{
 expect(defaultPersonResource(['.deleted','default'],[{profile:'default',models:['m']}])).toBe('default')
})
it('prefers the current usable resource but never unauthorized resources',()=>{
 const groups=[{profile:'work',models:['m']},{profile:'default',models:['m']}]
 expect(defaultPersonResource(['default','work'],groups,'work')).toBe('work')
 expect(defaultPersonResource(['work'],groups,'default')).toBe('work')
 expect(defaultPersonResource([],groups)).toBe('')
})
it('skips empty resources before falling back for native runtimes',()=>{
 expect(defaultPersonResource(['empty','work'],[{profile:'work',models:['m']}],'empty')).toBe('work')
 expect(defaultPersonResource(['default'],[])).toBe('default')
})
