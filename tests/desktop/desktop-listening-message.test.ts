import { expect, it } from 'vitest'
import { desktopListeningPort } from '../../packages/desktop/src/main/desktop-listening-message'
it('accepts only the spawned server port announcement with a valid bound TCP port',()=>{
 expect(desktopListeningPort({type:'hermes-desktop:listening',port:13245})).toBe(13245)
 for(const port of [0,-1,65536,'13245',null,NaN])expect(desktopListeningPort({type:'hermes-desktop:listening',port})).toBeNull()
 expect(desktopListeningPort({type:'other',port:13245})).toBeNull()
})
