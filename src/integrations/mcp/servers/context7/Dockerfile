FROM node:22-alpine
RUN addgroup -S mcp && adduser -S mcp -G mcp && \
    npm install -g @upstash/context7-mcp@2.1.2 && \
    npm cache clean --force
USER mcp
CMD ["context7-mcp"]
