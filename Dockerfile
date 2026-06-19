FROM node:20-alpine
WORKDIR /app
COPY . .
RUN ls -la && ls -la public/ || echo "NO PUBLIC DIR"
RUN npm ci --omit=dev
EXPOSE 3001
CMD ["node", "server/index.js"]
