FROM node:22-bookworm-slim

# Install Playwright Chromium system dependencies
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev=false

# Install Playwright Chromium browser and required OS libraries
RUN npx playwright install --with-deps chromium

COPY . .

# Build frontend Vite bundle
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "run", "start"]
