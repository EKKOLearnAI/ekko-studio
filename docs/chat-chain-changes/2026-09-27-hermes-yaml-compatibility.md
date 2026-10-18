---
date: 2026-09-27
pr: pending
feature: Use the Hermes YAML adapter for bridge configuration reads
impact: Restore MCP management and terminal configuration after Hermes replaces PyYAML.
---

Hermes 0.21.5 uses `hermes_yaml` backed by ruamel.yaml and its managed Python
does not necessarily include PyYAML. Direct `import yaml` in Studio's bridge
caused the MCP page to return HTTP 503 (`No module named 'yaml'`). The same
assumption prevented terminal configuration refresh and fallback config reads.

Load the upstream `hermes_yaml` adapter lazily for all three paths. Only fall
back to PyYAML when that adapter itself is absent, preserving legacy runtime
compatibility without hiding missing dependencies inside the new adapter.
MCP saves keep using Hermes' atomic writer and no longer import unused PyYAML.
This preserves upstream parsing policy, profile isolation, and unrelated config
fields without installing packages or modifying Hermes source.

Restart the bridge after deploying the Python files. Regression coverage checks
native and legacy parser paths, MCP read/write round trips, profile isolation,
fallback configuration, terminal environment refresh, and broken native imports.

Validation: 45 focused YAML/bootstrap/profile/MCP tests, `npm run harness:check`,
and `npm run build` passed. A temporary configuration round trip with the actual
Hermes 0.21.5 adapter passed without PyYAML installed. After restarting only the
development instance's bridge, its MCP list endpoint on port 8647 returned HTTP
200 with five configured servers. The separately installed desktop app needs
the updated bridge files through its normal build/update process.
