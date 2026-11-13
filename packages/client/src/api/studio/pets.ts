import { request } from '../client'

export interface WebPetPosition {
  x: number
  y: number
}

export interface ActivePet {
  enabled: boolean
  slug: string
  displayName: string
  kind: string
  submittedBy: string
  source: 'petdex'
  mime: string
  spritesheetDataUrl: string
  spritesheetRevision: number
  frameW: number
  frameH: number
  framesPerState: number
  loopMs: number
  scale: number
  position?: WebPetPosition
  stateRows: string[]
  installedAt: number
  updatedAt: number
}

export async function fetchActivePet(): Promise<ActivePet | null> {
  const res = await request<{ pet: ActivePet | null }>('/api/studio/pets/active')
  return res.pet
}

export async function adoptPet(slug: string): Promise<ActivePet> {
  const res = await request<{ pet: ActivePet }>('/api/studio/pets/adopt', {
    method: 'POST',
    body: JSON.stringify({ slug }),
  })
  return res.pet
}

export async function updateActivePetPreferences(input: {
  scale?: number
  position?: WebPetPosition
  enabled?: boolean
}): Promise<ActivePet | null> {
  const res = await request<{ pet: ActivePet | null }>('/api/studio/pets/active', {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
  return res.pet
}
