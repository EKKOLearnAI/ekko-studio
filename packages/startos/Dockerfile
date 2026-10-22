# Keep the upstream Studio build and entrypoint, but exclude the Hermes repository
# and virtual environment from the shipped image. The source image is never a
# layer in the final image; only its prebuilt /app payload is copied.
FROM ekkoye8888/hermes-web-ui:v0.7.36@sha256:06a3c3fc30c850f3f68c9c144afedee9c575ece848e55857e97915fd358c91f4 AS studio
FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 python3-venv ffmpeg bzip2 xz-utils procps \
    && rm -rf /var/lib/apt/lists/*
COPY --from=studio /app /app
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/home/agent \
    HERMES_HOME=/home/agent/.hermes \
    HERMES_WEB_UI_HOME=/home/agent/.hermes-web-ui \
    HERMES_WEBUI_STATE_DIR=/home/agent/.hermes-web-ui \
    HERMES_WEB_UI_MANAGED_GATEWAY=1 \
    HERMES_ALLOW_ROOT_GATEWAY=1 \
    NPM_CONFIG_PREFIX=/home/agent/.hermes-web-ui/coding-agent/npm \
    PATH=/home/agent/.hermes-web-ui/coding-agent/npm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EXPOSE 6060
ENTRYPOINT ["/app/bin/start-studio-all.sh"]
CMD []
