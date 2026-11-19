# Tailscale with the Serve config baked in. A bind mount of ./ts breaks on hosts that deploy only
# the compose file (Coolify), where the mount source ends up an empty directory and Serve never
# starts. Build contexts are cloned with the repository, so this works everywhere.
ARG TAILSCALE_VERSION=v1.102.5
FROM tailscale/tailscale:${TAILSCALE_VERSION}
COPY serve.json /config/serve.json
