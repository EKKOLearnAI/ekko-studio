---
name: grok-image-to-video
description: "Animate a local image into a short mp4 video through Hermes Web UI using xAI Grok Imagine."
version: 1.0.0
author: Ekko
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [xAI, Grok, image-to-video, video-generation, media]
prerequisites:
  commands: [curl]
---

# Grok Image To Video

Use this skill when the user wants to animate a local image into a short video with xAI Grok Imagine.

Do not use any built-in image or video generation tool as a fallback. If the Hermes Web UI endpoint returns `401`, `403`, connection failure, or any other error, stop and report the Hermes Web UI error to the user.

## Workflow

Call the local Hermes Web UI media endpoint. Pass a local image path; the server will check for xAI credentials, read the file, convert it to a base64 data URI, call xAI, poll until completion, and optionally save the generated mp4.

Endpoint:

```bash
POST <Hermes Web UI base URL>/api/studio/media/grok-image-to-video
```

Resolve the Hermes Web UI base URL in this order:

1. `HERMES_WEB_UI_URL` environment variable, if set.
2. `http://127.0.0.1:${PORT}`, if `PORT` is set.
3. `http://127.0.0.1:8648` for the Web UI single-server default.

Common local ports:

- Development API backend: `http://127.0.0.1:8647`. Use this with `npm run dev`; do not target the Vite frontend port.
- Web UI single-server default: `http://127.0.0.1:8648`.
- Desktop app default: `http://127.0.0.1:8748`.
- Custom port: set `HERMES_WEB_UI_URL` to the full base URL, or set `PORT` to use `http://127.0.0.1:${PORT}`.

When Hermes Web UI is running from the provided Docker Compose setup, the default external URL is `http://127.0.0.1:6060`.

Authentication:

The endpoint is protected by Hermes Web UI auth. Always send the Hermes Web UI server bearer token. This token is accepted only by Hermes Web UI media generation endpoints for agent skills; it is not a general Web UI login token.

Resolve the token in this order:

1. `AUTH_TOKEN` environment variable, if set.
2. `${HERMES_WEB_UI_HOME}/.token`, if `HERMES_WEB_UI_HOME` is set.
3. `${HERMES_WEBUI_STATE_DIR}/.token`, if `HERMES_WEBUI_STATE_DIR` is set.
4. `~/.hermes-web-ui/.token`.

Profile selection:

Use the current Hermes profile from the run instructions by sending `X-Hermes-Profile`.

If the run instructions include `[Current Hermes profile: <name>]`, include:

```bash
-H "X-Hermes-Profile: <name>"
```

Replace `<name>` with the exact profile name from the run instructions. Never send a placeholder value such as `<name>` or `<current-hermes-profile>`.

If no current profile is provided, omit the header and let the server fall back to the current Hermes active profile.

Required JSON fields:

- `image_path`: local path to a png, jpeg, or webp image.
- `prompt`: motion and style instructions for the generated video.

Optional JSON fields:

- `duration`: seconds, 1 to 15. Defaults to 8.
- `output_path`: local path where the server should save the mp4. If omitted, the server saves to `${HERMES_WEB_UI_HOME:-~/.hermes-web-ui}/media/<request_id>.mp4` and creates the `media` directory if needed.
- `timeout_ms`: maximum wait time. Defaults to 600000.

Example:

```bash
TOKEN="${AUTH_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -n "${HERMES_WEB_UI_HOME:-}" ] && [ -f "$HERMES_WEB_UI_HOME/.token" ]; then
  TOKEN="$(cat "$HERMES_WEB_UI_HOME/.token")"
fi
if [ -z "$TOKEN" ] && [ -n "${HERMES_WEBUI_STATE_DIR:-}" ] && [ -f "$HERMES_WEBUI_STATE_DIR/.token" ]; then
  TOKEN="$(cat "$HERMES_WEBUI_STATE_DIR/.token")"
fi
if [ -z "$TOKEN" ] && [ -f "$HOME/.hermes-web-ui/.token" ]; then
  TOKEN="$(cat "$HOME/.hermes-web-ui/.token")"
fi
if [ -z "$TOKEN" ]; then
  echo "Missing Hermes Web UI token. Check AUTH_TOKEN, HERMES_WEB_UI_HOME, HERMES_WEBUI_STATE_DIR, or ~/.hermes-web-ui/.token." >&2
  exit 1
fi

BASE_URL="${HERMES_WEB_UI_URL:-}"
if [ -z "$BASE_URL" ]; then
  BASE_URL="http://127.0.0.1:${PORT:-8648}"
fi
BASE_URL="${BASE_URL%/}"

curl -sS -X POST "$BASE_URL/api/studio/media/grok-image-to-video" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "image_path": "/absolute/path/to/input.png",
    "prompt": "Animate the subject with a slow cinematic push-in and subtle natural motion.",
    "duration": 8,
    "output_path": "/absolute/path/to/output.mp4"
  }'
```

If the response has `code: "missing_xai_token"`, tell the user to set `XAI_API_KEY` or complete xAI OAuth login in Hermes Web UI before retrying.

Return the generated `output_path`.
