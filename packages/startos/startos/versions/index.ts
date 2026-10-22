import { VersionGraph } from '@start9labs/start-sdk'
import { current } from './current'

export const versionGraph = VersionGraph.of({
  current,
  other: [],
})
