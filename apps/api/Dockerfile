FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm install
COPY apps/api ./apps/api
RUN npm --workspace apps/api run db:generate && npm --workspace apps/api run build
WORKDIR /app
ENV NODE_ENV=production
EXPOSE 3001
CMD ["sh","-c","npm --workspace apps/api run db:push && npm --workspace apps/api run db:seed && npm --workspace apps/api run start"]