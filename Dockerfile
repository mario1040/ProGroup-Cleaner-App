FROM node:22-alpine AS app-base
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps --no-audit --no-fund
COPY . .

FROM app-base AS api
ENV NODE_ENV=production
EXPOSE 4000
CMD ["npm", "run", "start:api"]

FROM app-base AS frontend-build
ARG VITE_API_BASE_URL=
ARG VITE_CLOUDINARY_CLOUD_NAME=
ARG VITE_CLOUDINARY_UPLOAD_PRESET=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_CLOUDINARY_CLOUD_NAME=${VITE_CLOUDINARY_CLOUD_NAME}
ENV VITE_CLOUDINARY_UPLOAD_PRESET=${VITE_CLOUDINARY_UPLOAD_PRESET}
RUN npm run build

FROM nginx:1.27-alpine AS web
COPY nginx/naris.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
