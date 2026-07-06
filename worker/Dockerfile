FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Run background worker
CMD ["npm", "start"]
