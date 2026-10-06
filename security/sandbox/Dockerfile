FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG OPENCLAW_VERSION=2026.8.2
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server openssh-client python3 ca-certificates blender ffmpeg libegl1 libegl-mesa0 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd /opt/kivro /job/input /job/work /job/output /job/config \
    && npm install --prefix /opt/openclaw --omit=dev --no-audit --no-fund openclaw@${OPENCLAW_VERSION} \
    && ln -s /opt/openclaw/node_modules/.bin/openclaw /usr/local/bin/openclaw \
    && usermod -p '*' node
COPY runner.mjs observations.mjs timing.mjs /opt/kivro/
COPY self-test.mjs /opt/kivro/self-test.mjs
COPY media-self-test.mjs /opt/kivro/media-self-test.mjs
COPY plugin /opt/kivro/plugin
USER 1000:1000
ENV HOME=/job/work/home OPENCLAW_HOME=/job/work/home OPENCLAW_STATE_DIR=/job/work/state OPENCLAW_CONFIG_PATH=/job/config/openclaw.json NODE_ENV=production
WORKDIR /job/work
ENTRYPOINT ["node", "/opt/kivro/runner.mjs"]
