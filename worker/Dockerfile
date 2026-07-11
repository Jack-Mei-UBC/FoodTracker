# Plain Node: the scraper talks to Flipp's JSON API, no browser required.
FROM node:20-slim

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Run background worker
CMD ["npm", "start"]
