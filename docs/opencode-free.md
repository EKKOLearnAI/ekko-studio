# OpenCode Free removal

OpenCode stopped anonymous free-tier access from third-party clients. Requests
return `403 FreeTierError` with “OpenCode's free tier can only be used from within
OpenCode”. Hermes removed its native `opencode-free` provider for this reason.

Studio no longer registers this provider, polls its catalog, or offers anonymous
Coding Agent/Ekko routing. Old cached catalogs and defaults cannot reintroduce
the native provider. Attempts to select it or resume scoped sessions using it
return a removal message before writing configuration or contacting OpenCode.

Existing profile files and historical sessions remain intact. Choose another
provider explicitly. OpenCode Zen (`opencode-zen`) and OpenCode Go (`opencode-go`)
remain available with their own API keys. To use OpenCode's free tier, use the
official OpenCode client. Custom providers with the same display name retain
their ordinary credential and configuration behavior.

See https://github.com/EKKOLearnAI/ekko-studio/issues/3173.
