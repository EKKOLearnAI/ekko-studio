# 2026-11-13 — upstream module migration

Upstream reference: EKKOLearnAI/ekko-studio `513d1a062`.

Adopts the Studio/Hermes/Ekko/Coding module ownership and upstream chat/plugin
runtime while retaining local USB, LAN peers, XiaoZhi, meetings, knowledge and
paper grading. Meeting/grading profile and bridge access now uses Studio ports
composed from bootstrap. Restores USB/LAN and grading MCP operations alongside
the upstream MCP catalog. Keeps bridge worker startup resilient when the old
working directory has been removed and preserves the XiaoZhi camera tool repair.
Live meeting analysis rooms and active buffers are keyed by authenticated user;
browser speech upgrades require credentials and do not forward them to Python.
Legacy WeChat bindings and their existing profile ownership are migrated into
Studio account state. Expert Center and Experts Marketplace are
removed; ordinary profile selection, skills and plugins remain available.

Web UI update orchestration remains independent from Agent upgrades. This is a
source integration; it does not publish a tag or run an update on a device.
