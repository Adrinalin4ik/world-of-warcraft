# Build stage
FROM mhart/alpine-node:10.11.0 as builder

WORKDIR /build
ARG env
ENV env ${env}
# For cache node_modules
COPY package.json .
RUN npm install
# ---------
COPY . .

RUN npm run build:${env}
# --------------------------
FROM nginx:alpine

COPY --from=builder /build /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
