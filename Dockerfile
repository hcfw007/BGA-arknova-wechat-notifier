FROM node:18-alpine

RUN apk -u add --no-cache python3 gcc make g++

WORKDIR /app

COPY ./src ./src
COPY ./package.json ./package.json
COPY ./tsconfig.json ./tsconfig.json

RUN npm install

ENTRYPOINT npm start