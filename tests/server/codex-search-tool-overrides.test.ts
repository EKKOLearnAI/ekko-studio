import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexSearchToolOverrides } from '../../packages/server/src/modules/coding-agents/services/codex/search-tool-overrides'
let dir: string
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'codex-search-scope-'))})
afterEach(async()=>{await rm(dir,{recursive:true,force:true})})
async function config(models: unknown){const p=join(dir,'models.json');await writeFile(p,JSON.stringify({models}));return `model_catalog_json=${JSON.stringify(p)}`}
it('imports only the selected model from the current provider configuration',async()=>{
 const c=await config([{slug:'target',supports_search_tool:false},{slug:'other',supports_search_tool:false}])
 expect([...await codexSearchToolOverrides(c,'target',dir)]).toEqual([['target',false]])
 expect((await codexSearchToolOverrides('', 'target',dir)).size).toBe(0)
 expect((await codexSearchToolOverrides(c,'missing',dir)).size).toBe(0)
})
it('preserves explicit true and uses the supplied configuration home for tilde',async()=>{
 await config([{slug:'target',supports_search_tool:true}])
 expect((await codexSearchToolOverrides('model_catalog_json="~/models.json"','target',dir)).get('target')).toBe(true)
})
it('does not import unrelated malformed capabilities',async()=>{
 const c=await config([{slug:'other',supports_search_tool:'invalid'}])
 expect((await codexSearchToolOverrides(c,'target',dir)).size).toBe(0)
})
it('rejects malformed selected values and duplicate entries clearly',async()=>{
 let c=await config([{slug:'target',supports_search_tool:'false'}])
 await expect(codexSearchToolOverrides(c,'target',dir)).rejects.toThrow('must be boolean')
 c=await config([{slug:'target',supports_search_tool:false},{slug:'target',supports_search_tool:true}])
 await expect(codexSearchToolOverrides(c,'target',dir)).rejects.toThrow('duplicate')
})
it('reports the file on missing or invalid catalogs',async()=>{
 await expect(codexSearchToolOverrides(`model_catalog_json=${JSON.stringify(join(dir,'missing.json'))}`,'target',dir)).rejects.toThrow('missing.json')
 await writeFile(join(dir,'bad.json'),'{')
 await expect(codexSearchToolOverrides(`model_catalog_json=${JSON.stringify(join(dir,'bad.json'))}`,'target',dir)).rejects.toThrow('bad.json')
})
it('rejects ambiguous relative paths and invalid path types',async()=>{
 await expect(codexSearchToolOverrides('model_catalog_json="relative.json"','target',dir)).rejects.toThrow('absolute path')
 await expect(codexSearchToolOverrides('model_catalog_json=1','target',dir)).rejects.toThrow('absolute path')
})
