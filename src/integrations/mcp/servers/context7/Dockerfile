FROM node:22-alpine
RUN addgroup -S mcp && adduser -S mcp -G mcp
RUN npm install -g @upstash/context7-mcp@2.1.2
USER mcp
CMD ["context7-mcp"]
