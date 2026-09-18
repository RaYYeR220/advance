FROM node:24-bookworm-slim

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# entrypoint.sh installs (or reinstalls, on lockfile change) node_modules into
# the named volumes mounted over it, then execs the given command - see
# docker/README.md.
ENTRYPOINT ["entrypoint.sh"]
CMD ["sleep", "infinity"]
