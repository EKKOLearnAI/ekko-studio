# Qoder

Independent Studio plugin using the public SDK and standard ACP driver. Keeps
Qoder's existing native account mode, image prompts, approvals, session restore,
MCP injection and native command discovery. The plugin does not import Studio
application code or implement a vendor switch in the host.

An explicit administrator operation installs `@qoder-ai/qodercli@1.1.78` in the
instance's private CLI directory. Native login uses `qoder login`. Inspection
performs only an ACP metadata handshake; it reports authentication as unknown
and does not create a session or send an inference request. Windows ARM64 is
rejected before launching Qoder. Studio model mode is not introduced by this
migration; Qoder retains its existing global-only mode.

Resource locations respect `QODER_CONFIG_DIR`, `QODER_CLI_HOME`, the normalized
`QODER_CONFIG_DIR_NAME`, and an explicit `--config-dir`. They include native and
workspace Skills, shared `.agents/skills`, settings, memory and instructions.
Loading project resources still depends on Qoder's workspace trust settings.

References: [installation](https://docs.qoder.com/cli/installation),
[ACP](https://docs.qoder.com/cli/acp),
[settings and paths](https://docs.qoder.com/cli/settings-reference), and the
README and implementation shipped with the pinned npm package. Real account,
remote inference, cross-platform and complete migration acceptance remain
separate requirements.
