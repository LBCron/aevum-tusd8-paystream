FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts --no-audit --no-fund

COPY contracts ./contracts
COPY scripts ./scripts
COPY src ./src
COPY test ./test

RUN npm run compile

EXPOSE 3000

CMD ["node", "src/server.js"]
