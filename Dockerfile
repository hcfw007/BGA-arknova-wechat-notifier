FROM node:18-alpine

RUN apk -u add --no-cache python3 gcc make g++

WORKDIR /app

COPY ./dist ./dist
COPY ./node_modules ./node_modules

ENTRYPOINT node ./dist/index.js