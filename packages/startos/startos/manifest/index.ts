import { setupManifest } from '@start9labs/start-sdk'
import { long, short } from './i18n'

export const manifest = setupManifest({
  id: 'ekko-studio',
  title: 'Ekko Studio',
  license: 'BUSL-1.1',
  packageRepo: 'https://github.com/EKKOLearnAI/ekko-studio-startOS',
  upstreamRepo: 'https://github.com/EKKOLearnAI/ekko-studio',
  marketingUrl: 'https://ekkostudio.xyz',
  donationUrl: null,
  description: { short, long },
  volumes: ['main', 'startos'],
  images: {
    studio: {
      source: { dockerBuild: {} },
      arch: ['x86_64', 'aarch64'],
    },
  },
})
