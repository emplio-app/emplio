# The computer each person's Emplio works on. Word and PowerPoint previews need LibreOffice; the fonts stand in for
# Office's own so pages keep their layout.
FROM node:22-bookworm-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      bash ca-certificates coreutils curl git iptables jq procps python3 python3-pip python3-venv ripgrep sudo tar unzip util-linux wget zip \
      poppler-utils libreoffice-writer-nogui libreoffice-impress-nogui \
      fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea fonts-dejavu-core \
      fonts-noto-core build-essential tini \
    && rm -rf /var/lib/apt/lists/*
# Indian and other scripts in documents (fonts-noto-core), and packages that build from source (build-essential).
# pip installs anywhere, as on a person's own computer; the document libraries are there from the start.
ENV LANG=C.UTF-8 PIP_BREAK_SYSTEM_PACKAGES=1
RUN pip install -q --no-cache-dir openpyxl pandas python-docx python-pptx
# what runs commands inside the computer when gVisor runs it directly (runner/gvisor.ts)
COPY --chmod=644 computer-helper.js /usr/local/lib/emplio-computer-helper.js
RUN useradd -m -s /bin/bash user && echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/user && chmod 440 /etc/sudoers.d/user
USER user
WORKDIR /home/user
# The browser tool, for this machine's kind of processor, and its guides. Keep the version the same as sandbox.ts.
ARG AGENT_BROWSER=0.41.2
RUN mkdir -p .local/bin .local/share/agent-browser \
    && curl -fsSL "https://codeload.github.com/vercel-labs/agent-browser/tar.gz/refs/tags/v${AGENT_BROWSER}" | tar -xz -C .local/share/agent-browser --strip-components=2 --wildcards '*/skill-data/*' \
    && arch="$(dpkg --print-architecture)" && [ "$arch" = amd64 ] && arch=x64; \
    curl -fsSL "https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER}/agent-browser-linux-${arch}" -o .local/bin/agent-browser \
    && chmod +x .local/bin/agent-browser
CMD ["sleep", "infinity"]
