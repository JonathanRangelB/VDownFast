FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim AS runtime
ENV NODE_ENV=production HOME=/home/node PATH=/home/node/bin:/usr/local/bin:/usr/bin:/bin
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app /home/node/bin /tmp/dl /data /sessions \
  && curl -L --fail --silent --show-error https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod 755 /usr/local/bin/yt-dlp \
  && cp /usr/local/bin/yt-dlp /home/node/bin/yt-dlp \
  && chown -R node:node /app /home/node/bin /tmp/dl /data /sessions \
  && chmod 755 /home/node/bin/yt-dlp
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod 755 docker-entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
