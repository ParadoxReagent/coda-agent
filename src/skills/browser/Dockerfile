FROM mcr.microsoft.com/playwright/mcp:latest

# The official ENTRYPOINT is:
#   node cli.js --headless --browser chromium --no-sandbox
# CMD args are appended, so the full command becomes:
#   node cli.js --headless --browser chromium --no-sandbox --user-data-dir /tmp/mcp-chrome
CMD ["--user-data-dir", "/tmp/mcp-chrome"]
