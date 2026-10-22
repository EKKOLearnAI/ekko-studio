import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.7.36:1',
  releaseNotes: {
    en_US:
      'Separate Hermes runtime from the application image; preserve existing user data and installed runtimes.',
    es_ES:
      'Separa el runtime de Hermes de la imagen; conserva los datos y runtimes instalados.',
    de_DE:
      'Hermes-Laufzeit von der Anwendung getrennt; vorhandene Daten und Laufzeiten bleiben erhalten.',
    pl_PL:
      'Oddzielono środowisko Hermes od obrazu aplikacji; zachowano dane i zainstalowane środowiska.',
    fr_FR:
      'Séparation du runtime Hermes de l’image ; conservation des données et runtimes installés.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
