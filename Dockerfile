FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
RUN mkdir -p /app/data
ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000
CMD ["node", "server/index.js"]
