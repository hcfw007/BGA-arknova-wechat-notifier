FROM node:20-alpine

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.ustc.edu.cn/g' /etc/apk/repositories

RUN apk -u add --no-cache git libsodium python3 py-pip ffmpeg gcc g++ make bash figlet linux-headers autoconf automake libtool tzdata bind-tools
RUN apk add --no-cache \
  nss \
  freetype \
  harfbuzz \
  ca-certificates \
  ttf-freefont

WORKDIR /app

COPY . .

RUN npm install
# RUN npm install typescript -g
RUN npm run dist

ENTRYPOINT node ./dist/index.js