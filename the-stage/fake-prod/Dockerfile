FROM node:22-alpine
WORKDIR /app
# The release is BAKED into the image — registry-backed deploys pull the
# exact version and the container reports exactly what was pushed.
ARG APP_VERSION=v1.42.0
ENV APP_VERSION=${APP_VERSION}
COPY server.js .
EXPOSE 8080
CMD ["node", "server.js"]
