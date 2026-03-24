FROM node:22-alpine
RUN apk add --no-cache chromium font-noto font-noto-extra
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY index.js .
EXPOSE 8080
CMD ["node", "index.js"]
