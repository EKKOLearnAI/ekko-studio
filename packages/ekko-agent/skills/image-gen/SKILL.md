---
name: image-gen
description: Generate or edit images through Ekko Studio using the current Profile's configured image provider.
metadata:
  keywords:
    - image generation
    - generate image
    - edit image
---

# Studio image generation

Use this Skill when the user wants to generate a new image, transform a reference image, or edit selected visual content through Ekko Studio's configured image provider.

Always use the Studio media endpoint through the bundled helper. Do not call an upstream image API directly, request an API key in chat, or fall back to a different image-generation tool when Studio reports an error. The server owns provider selection and credentials.

## Helper

`skill_view` returns this Skill's `baseDirectory`. Run:

```text
node <baseDirectory>/scripts/studio-image-gen.mjs --mode text --profile <runtime-profile> --prompt <prompt> [options]
```

Use the exact `profile` shown under **Runtime Context** in the Ekko system prompt. The helper resolves the local Studio URL and server token without printing the token. It outputs JSON containing `output_paths` on success.

Before returning an image, verify the reported file exists and reference its absolute path with Markdown image syntax.

## Modes

### Text to image

Use when there is no reference image:

```text
--mode text --prompt "A matte black mechanical keyboard on a clean desk" --size 1024x1024
```

### Image to image

Use when the user wants a new composition or redraw based on a reference:

```text
--mode image --image-path /absolute/path/reference.png --prompt "Create a refined technology brand poster"
```

### Image edit

Use when parts of the source should be preserved:

```text
--mode edit --image-path /absolute/path/source.png --prompt "Change the background to blue and keep the subject unchanged"
```

`image` and `edit` require either `--image-path` or `--image-url`. Use a local absolute path for an attached or workspace image. Do not transmit a private local image to the configured provider unless that is necessary for the user's requested edit.

## Options

- `--profile <name>`: required in Ekko runs; use the current runtime Profile.
- `--provider <name>`: optional configured custom provider. Omit it to use the Profile's image route and server fallback.
- `--size <width>x<height>`: defaults to `1024x1024`. Also accepts `auto` when supported.
- `--quality <value>`: optional provider quality setting.
- `--n <count>`: number of images; defaults to `1`.
- `--model <name>`: optional primary-model override.
- `--image-model <name>`: optional image-tool-model override for image-to-image mode.
- `--output-path <absolute-path>`: optional requested destination. When omitted, Studio writes under its media directory.
- `--timeout-ms <milliseconds>`: request timeout; defaults to 600000 and is capped at 1800000 by the helper.

Do not invent a provider or model override. Use them only when the user requested one or the current task supplies a known configured value.

## Errors

- `missing_fun_codex_provider`: the current Profile has no default `fun-codex` provider or configured image route.
- `missing_apikey_image_provider`: the requested provider is absent from the current Profile.
- `profile_not_found`: the Ekko Profile does not map to an existing Studio/Hermes Profile used by the media endpoint.
- `401`, `403`, connection failure, timeout, or any provider error: report the Studio error and stop. Do not bypass Studio or silently retry against another service.
