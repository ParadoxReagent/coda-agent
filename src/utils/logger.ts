/**
 * Structured logging with PII redaction.
 *
 * Redaction policy:
 * - DEFAULT (INFO): Never logs message content, email bodies, or credentials
 * - DEBUG: May include redacted tool call inputs/outputs for troubleshooting
 * - All paths listed in `redact.paths` are replaced with "[REDACTED]"
 */
import pino from "pino";

export function createLogger(name?: string) {
  const logger = pino({
    name: name ?? "coda",
    level: process.env.LOG_LEVEL ?? "info",
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
    transport:
      process.env.NODE_ENV !== "production"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  });

  return logger;
}

export type Logger = pino.Logger;

export const logger = createLogger();
