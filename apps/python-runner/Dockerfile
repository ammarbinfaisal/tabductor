FROM docker:27-cli AS dockercli
FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
RUN npm install --omit=dev ws@8.18.3 @kubernetes/client-node@2.0.0
RUN npm pkg set type=module
COPY apps/python-runner/src /app
RUN sed -i 's|./containers.js|./containers.ts|' /app/main.ts
ENV NODE_ENV=production
CMD ["node", "--experimental-strip-types", "/app/main.ts"]
