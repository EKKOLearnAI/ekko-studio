# Ekko Studio

## Documentation

- [Ekko Studio user guide](https://github.com/EKKOLearnAI/ekko-studio/blob/main/README.md) — model configuration, agents, and application features.

## Getting set up

1. Complete **Set Admin Password** and save the generated password.
2. Start Ekko Studio and open **Web Interface**.
3. Sign in as `admin` with the generated password.
4. Add your preferred model provider in Studio and configure an agent before starting a chat.
5. To use Hermes, open Studio’s version management page, download a Hermes runtime for your architecture, install it, and select it. Follow the restart prompt. This requires network access for the initial runtime download; Ekko Agent does not require this step.

Your conversations, uploaded files, agent settings, and files created in the
default workspace remain in this instance. Use the default workspace for files
you want the package to preserve.

## Administrator access

If you lose the password, stop the service and run **Set Admin Password** again.
This replaces the password; it does not display the old one. Keep the managed
account named `admin`. Create additional accounts inside Studio when needed.

## Supported connections

Use **Web Interface** for the browser, API, and live chat. Direct LAN discovery,
UDP peer connections, preview development servers, and separate OAuth callback
listeners are not exposed by this package. Configure provider API credentials
when a provider's callback-based sign-in is unavailable. Model providers may
require their own accounts and fees; none are included with the package.

## Hermes runtime and upgrades

Hermes is managed independently of the application package. Updating this package
does not reinstall or reset a downloaded runtime. After upgrading from a package
that bundled Hermes, download and select a managed runtime if none is installed;
your Hermes profiles and Studio data remain preserved.
