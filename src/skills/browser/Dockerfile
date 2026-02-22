FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

# Install the playwright npm package — browsers are already bundled in the base image.
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 skips the post-install browser download step.
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install playwright@1.58.2 --save

COPY playwright-server.js /app/playwright-server.js

EXPOSE 3000

CMD ["node", "/app/playwright-server.js"]
