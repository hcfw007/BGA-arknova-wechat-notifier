FROM node:18-alpine

RUN apk -u add --no-cache python3 gcc make g++ chromium

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
  PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY . .

RUN npm install --production
RUN npm install typescript -g
RUN npm run dist

ENTRYPOINT node ./dist/index.js