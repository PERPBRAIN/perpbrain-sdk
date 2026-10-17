FROM node:22-slim

RUN groupadd --gid 10001 perpbrain \
  && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin perpbrain

WORKDIR /app
COPY package.json server.json ./
COPY bin ./bin
COPY ts/mcp-server/package.json ts/mcp-server/package-lock.json ./ts/mcp-server/
COPY ts/mcp-server/src ./ts/mcp-server/src
COPY sdk/src ./sdk/src
COPY fixtures ./fixtures

WORKDIR /app/ts/mcp-server
RUN npm ci --omit=dev

USER 10001:10001
WORKDIR /app
ENTRYPOINT ["node", "bin/perpbrain-mcp.mjs"]
