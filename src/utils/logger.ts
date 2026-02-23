/**
 * Structured logging with PII redaction and correlation context.
 *
 * Redaction policy:
 * - DEFAULT (INFO): Never logs message content, email bodies, or credentials
 * - DEBUG: May include redacted tool call inputs/outputs for troubleshooting
 * - All paths listed in `redact.paths` are replaced with "[REDACTED]"
 */
import pino from "pino";
import { getCurrentContext } from "../core/correlation.js";

export function createLogger(name?: string) {
  const logger = pino({
    name: name ?? "coda",
    level: process.env.LOG_LEVEL ?? "info",
    serializers: {
      // Pino only serializes Error objects for the `err` key by default.
      // Add `error` so logger.error({ error: someError }) shows message + stack.
      error: pino.stdSerializers.err,
    },
    redact: {
      paths: [
        "msg.emailBody",
        "msg.messageContent",
        "msg.credentials",
        "msg.apiKey",
        "msg.password",
        "msg.token",
        "msg.*.emailBody",
        "msg.*.messageContent",
        "emailBody",
        "messageContent",
        "credentials",
        "apiKey",
        "password",
        "token",
        "*.emailBody",
        "*.messageContent",
      ],
      censor: "[REDACTED]",
    },
    mixin() {
      const ctx = getCurrentContext();
      if (ctx) {
        return {
          correlationId: ctx.correlationId,
          ...(ctx.userId ? { userId: ctx.userId } : {}),
        };
      }
      return {};
    },
    transport:
      process.env.NODE_ENV !== "production"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  });

  return logger;
}

export type Logger = pino.Logger;

export const logger = createLogger();
