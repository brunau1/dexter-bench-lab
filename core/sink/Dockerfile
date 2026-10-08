# Built by `bench prepare` with the kit's pinned node image (core/versions.yaml) as NODE_IMAGE.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
WORKDIR /sink
COPY server.js ./
USER node
EXPOSE 9000
HEALTHCHECK --interval=1s --retries=30 CMD wget -qO- http://127.0.0.1:9000/health || exit 1
CMD ["node", "server.js"]
