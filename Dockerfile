# One image for both processes. The command decides the role:
#   API:     node src/server.js   (default)
#   Worker:  node src/worker.js
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json prisma.config.js ./
COPY prisma ./prisma
# --omit=dev keeps test and lint tools out of the image. The Prisma CLI is a
# production dependency because containers run `prisma migrate deploy`.
RUN npm ci --omit=dev && npx prisma generate

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json prisma.config.js ./
COPY prisma ./prisma
COPY src ./src
COPY public ./public
# Do not run as root inside the container.
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
