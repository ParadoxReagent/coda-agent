#!/bin/sh
# Dynamic Docker socket permission setup
# Ensures the node user can access the Docker socket regardless of host GID

if [ -S /var/run/docker.sock ]; then
  # Get the socket's group ID (works on both Linux and Alpine)
  DOCKER_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || stat -f '%g' /var/run/docker.sock 2>/dev/null)

  if [ -n "$DOCKER_GID" ] && [ "$DOCKER_GID" != "0" ]; then
    # Socket is owned by a non-root group - create matching group and add node user
    addgroup -g "$DOCKER_GID" docker 2>/dev/null || true
    addgroup node docker 2>/dev/null || true
  else
    # Socket is owned by root (GID 0) - add node to root group
    addgroup node root 2>/dev/null || true
  fi
fi

# Execute the command as the node user
exec su-exec node "$@"
