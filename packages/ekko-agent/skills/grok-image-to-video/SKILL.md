---
name: grok-image-to-video
description: Animate a local image into a short MP4 through Ekko Studio using xAI Grok Imagine.
metadata:
  keywords:
    - image to video
    - grok imagine
    - animate image
---

# Grok image to video

Use this Skill when the user wants to animate a local image into a short video with xAI Grok Imagine.

Always use the Studio media endpoint through the bundled helper. Do not call xAI directly, request credentials in chat, or fall back to another image/video generator when Studio reports an error. Studio owns xAI credential resolution, request polling, download, and Profile selection.

## Workflow

1. Resolve the exact local source image. It must be PNG, JPEG, or WebP and necessary for the user's requested generation.
2. Write a motion prompt that preserves the user's intended subject, composition, camera movement, and style. Do not add people, branding, or sensitive traits the user did not request.
3. Use the exact `profile` shown under **Runtime Context** in the Ekko system prompt.
4. `skill_view` returns this Skill's `baseDirectory`. Run:

```text
node <baseDirectory>/scripts/grok-image-to-video.mjs --profile <runtime-profile> --image-path /absolute/path/input.png --prompt "Slow cinematic push-in with subtle natural motion" [options]
```

5. The helper calls Studio, waits for completion, verifies the downloaded file, and returns JSON containing `output_path`.
6. Verify the file exists, then return it as an absolute Markdown file link so Studio renders the video player.

## Options

- `--profile <name>`: required in Ekko runs; use the current runtime Profile.
- `--duration <seconds>`: integer from 1 to 15; defaults to 8.
- `--output-path <absolute-path.mp4>`: optional requested destination. When omitted, Studio writes under its media directory.
- `--timeout-ms <milliseconds>`: defaults to 600000 and is capped at 1800000.

The local call can legitimately take several minutes. Set the `terminal_exec` tool timeout slightly above `--timeout-ms`; do not start duplicate generations while the first request is still pending.

## Errors

- `missing_xai_token`: configure `XAI_API_KEY` or complete xAI OAuth login for the current Profile in Ekko Studio.
- `profile_not_found`: the Ekko Profile does not map to an existing Studio/Hermes Profile used by the media endpoint.
- `401`, `403`, connection failure, timeout, expired request, provider failure, or missing output: report the Studio error and stop. Do not bypass Studio or silently retry against another service.
