FROM node:18-alpine

RUN apk -u add --no-cache python3 gcc make g++

WORKDIR /app

COPY . .

RUN npm install
RUN npm install typescript -g
RUN npm run dist

ENTRYPOINT node ./dist/index.js