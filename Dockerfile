# ProblemVault: Python standard library only, plus the Claude Code CLI so
# "Ask Claude" in the app runs on your Claude subscription (log in once, see README).
FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://claude.ai/install.sh | bash \
    && cp -L /root/.local/bin/claude /usr/local/bin/claude \
    && claude --version
# HOME on the data volume: a login made with `docker exec ... claude` survives updates.
# The image is rebuilt on every push, so Claude Code's own auto-update is off.
ENV PORT=8787 DATA_DIR=/data HOME=/data/home PYTHONUNBUFFERED=1 DISABLE_AUTOUPDATER=1 USE_BUILTIN_RIPGREP=0
COPY server ./server
COPY public ./public
COPY run.py mcp_stdio.py ./
LABEL org.opencontainers.image.title="ProblemVault" \
      org.opencontainers.image.description="Homework workspaces: draw over your problems, check them with Claude"
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8787/api/session')" || exit 1
CMD ["python", "run.py"]
