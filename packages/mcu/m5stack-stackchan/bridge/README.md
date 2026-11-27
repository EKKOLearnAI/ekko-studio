# StackChan MCP bridge

stdio MCP server that lets a Studio Agent control a paired StackChan over the
LAN. It is the reference implementation the upcoming Studio BOT can reuse or
replace; device endpoints are documented in
[../docs/CURRENT-FIRMWARE.md](../docs/CURRENT-FIRMWARE.md).

| File | Purpose |
| --- | --- |
| `pulse_mcp.py` | MCP server: `capabilities`, `status`, `set_emotion`, `play_action`, `respond_to_emotion`, `look_at_camera`, `stop`; `notify_user` with the `notify` toolset |
| `expression_catalog.py`, `affect_policy.py` | Intent/scene catalog and the emotion director (cooldowns, de-duplication, intensity caps) |
| `face_affect.py` | Optional local visible-expression estimation from `/api/face/sample` (ONNX, CPU) |
| `scene_vision.py` | Optional on-demand single-frame description for `look_at_camera` |
| `pulse_notify.py` | Task reminder push to `/api/notify` |
| `stackchan-persona.md` | Persona prompt for the `stackchan` profile |
| `verify_profile.py` | Checks that a profile exposes exactly the expected pulse tools |
| `test_*.py` | Unit tests (mock transport, no device needed) |

## Install

Use a dedicated Python 3.11 virtual environment:

```bash
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install -r requirements-face.txt   # optional, local expression estimation
.venv/bin/python -B -m unittest test_pulse_mcp test_direction_actions test_expression_catalog test_affect_policy
```

## Profile configuration

```yaml
mcp_servers:
  pulse:
    command: /path/to/.venv/bin/python
    args: ["-I", "-B", "/path/to/bridge/pulse_mcp.py"]
    env:
      PULSE_CONNECTION_FILE: ~/.hermes/profiles/stackchan/pulse-connection.json
      PYTHONDONTWRITEBYTECODE: "1"
      # optional
      # PULSE_FACE_BACKEND: mobilefacenet
      # PULSE_FACE_MODEL_FILE: /path/to/facial_expression_recognition_mobilefacenet_2022july.onnx
    enabled: true
    tools:
      resources: false
      prompts: false
platform_toolsets:
  cli: [mcp-pulse]
```

Disable every other Hermes toolset in this profile so the voice Agent can only
reach the robot.

`PULSE_CONNECTION_FILE` must be a regular file owned by the current user with
mode `0600`:

```json
{ "endpoint": "http://<device-ip>", "control_token": "<from USB {\"op\":\"pairing\"}>" }
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PULSE_MCP_TOOLSET` | `voice` | `voice`, `notify`, or `voice,notify`; anything else refuses to start |
| `PULSE_FACE_BACKEND` | `ferplus` | `ferplus` or `mobilefacenet` (modern expression model) |
| `PULSE_SCENE_ALLOW_REAL_IMAGES` | `false` | Must be explicitly set by the owner before camera frames are sent to a vision service |
| `PULSE_SCENE_BASE_URL`, `PULSE_SCENE_MODEL`, `PULSE_SCENE_API_KEY` | — | Vision service for `look_at_camera` |

For another profile that should only push task reminders, run the server with
`PULSE_MCP_TOOLSET=notify` and include only `notify_user`. The device has a
single control token shared by `/api/control` and `/api/notify`, so any Agent
able to read the connection file can also control the robot.

## Privacy

- Face samples and camera frames are processed in memory and are not written to
  disk or returned as MCP image content; only structured text results enter the
  chat history.
- Camera frames leave the machine only when `PULSE_SCENE_ALLOW_REAL_IMAGES=true`
  and a vision service is configured.
- Expression estimates describe visible expressions only; they are not identity
  recognition or a diagnosis of the user's feelings.
