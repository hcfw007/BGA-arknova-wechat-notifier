FROM node:18-alpine

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.ustc.edu.cn/g' /etc/apk/repositories

RUN apk -u add --no-cache git libsodium python3 py-pip ffmpeg gcc g++ make bash figlet linux-headers autoconf automake libtool tzdata bind-tools
RUN apk add --no-cache \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ca-certificates \
  ttf-freefont

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
  PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY . .

RUN npm install --production
# RUN npm install typescript -g
RUN npm run dist

ENTRYPOINT node ./dist/index.js