import { request } from '@/api/client'

export interface PetdexPet {
  slug: string
  displayName: string
  kind: string
  submittedBy: string
  spritesheetUrl: string
  previewUrl?: string
  petJsonUrl: string
  zipUrl: string
}

export interface PetdexManifest {
  generatedAt: string
  total: number
  pets: PetdexPet[]
}

export function fetchPetdexManifest(force = false): Promise<PetdexManifest> {
  return request<PetdexManifest>(`/api/studio/petdex/manifest${force ? '?force=1' : ''}`)
}
