FROM oven/bun:1.4.5 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run check

FROM oven/bun:1.4.5 AS runtime
WORKDIR /app
ENV PORT=3000 HOST=0.0.0.0 FOLIO_DB=/data/folio.sqlite NODE_ENV=production
RUN mkdir -p /data && chown bun:bun /data
COPY --from=build /app/dist ./dist
COPY --from=build /app/service ./service
COPY --from=build /app/legal ./legal
USER bun
EXPOSE 3000
CMD ["bun","service/index.js"]
