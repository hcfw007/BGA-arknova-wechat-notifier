FROM node:18-alpine

FROM node:16-alpine
WORKDIR /app

COPY ./src ./src
COPY ./package.json ./package.json
COPY ./tsconfig.json ./tsconfig.json

RUN npm install

ENTRYPOINT npm start