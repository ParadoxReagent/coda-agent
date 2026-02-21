#!/bin/sh
# Dynamic Docker socket permission setup
# Ensures the node user can access the Docker socket regardless of host GID

if [ -S /var/run/docker.sock ]; then
  # Get the socket's group ID (works on both Linux and Alpine)
  DOCKER_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || stat -f '%g' /var/run/docker.sock 2>/dev/null)

  if [ -n "$DOCKER_GID" ] && [ "$DOCKER_GID" != "0" ]; then
    # Find a group that already has this GID (e.g. docker-cli package may have
    # pre-created a "docker" group with a different GID, making addgroup -g fail).
    SOCK_GROUP=$(awk -F: '$3 == '"$DOCKER_GID"' { print $1; exit }' /etc/group)
    if [ -z "$SOCK_GROUP" ]; then
      # No existing group has this GID — create one
      addgroup -g "$DOCKER_GID" dockersock
      SOCK_GROUP=dockersock
    fi
    addgroup node "$SOCK_GROUP" 2>/dev/null || true
  else
    # Socket is owned by root (GID 0) - add node to root group
    addgroup node root 2>/dev/null || true
  fi
fi

# Execute the command as the node user
exec su-exec node "$@"
