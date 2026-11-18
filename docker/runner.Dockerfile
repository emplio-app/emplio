# The gatekeeper: the only container that can talk to Docker (runner/runner.ts).
FROM oven/bun:1.3.11-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://download.docker.com/linux/static/stable/$(uname -m)/docker-27.5.1.tgz" | tar -xz --strip-components=1 -C /usr/local/bin docker/docker
COPY runner/runner.ts runner/gvisor.ts /
CMD ["bun", "/runner.ts"]
