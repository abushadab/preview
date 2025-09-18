FROM node:20-bullseye

# Add non-root user (node user exists by default in Node image)
# Create appuser as fallback, but prefer existing node user
RUN useradd -m -s /bin/bash appuser 2>/dev/null || true
# Ensure node user exists and has proper shell
RUN groupadd -f appgroup && useradd -m -s /bin/bash -g appgroup node 2>/dev/null || true
RUN mkdir -p /work /home/node/.local /home/appuser/.local
RUN chown -R node:node /work /home/node/.local 2>/dev/null || chown -R appuser:appgroup /work /home/appuser/.local

# Set environment variables for both users
ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV NEXT_TELEMETRY_DISABLED=1

RUN corepack enable && apt-get update && apt-get install -y \
    python3 build-essential git ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /work
# Create work directory with proper permissions
RUN chown -R node:node /work 2>/dev/null || chown -R appuser:appgroup /work

# Will receive project files at runtime; install runs inside container
EXPOSE 3000

# Create entrypoint script to handle permissions
RUN echo '#!/bin/bash\n\
# Ensure user can write to work directory\n\
chown -R $(id -u):$(id -g) /work 2>/dev/null || true\n\
# Try pnpm first, fallback to npm\n\
pnpm i || npm i && pnpm next dev --turbo --port 3000 --hostname 0.0.0.0' > /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

USER node
CMD ["bash", "-lc", "/usr/local/bin/entrypoint.sh"]