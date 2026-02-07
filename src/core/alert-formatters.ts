import type { CodaEvent } from "./events.js";

/** Severity → Discord embed color mapping. */
const SEVERITY_COLORS: Record<string, number> = {
  high: 0xff0000, // red
  medium: 0xff8c00, // orange
  low: 0x3498db, // blue
};

/** Severity → emoji for plain text. */
const SEVERITY_ICONS: Record<string, string> = {
  high: "[HIGH]",
  medium: "[MEDIUM]",
  low: "[LOW]",
};

// ─── Discord Embed Formatter ───────────────────────────────────────

export function formatAlertForDiscord(
  event: CodaEvent
): { embeds: unknown[] } {
  const color = SEVERITY_COLORS[event.severity] ?? 0x95a5a6;
  const title = formatEventTitle(event);
  const description = formatEventDescription(event);
  const fields = buildEmbedFields(event);

  return {
    embeds: [
      {
        title,
        description,
        color,
        fields,
        timestamp: event.timestamp,
        footer: {
          text: `Source: ${event.sourceSkill}`,
        },
      },
    ],
  };
}

// ─── Slack Block Kit Formatter ─────────────────────────────────────

export function formatAlertForSlack(event: CodaEvent): {
  blocks: unknown[];
} {
  const icon = SEVERITY_ICONS[event.severity] ?? "[INFO]";
  const title = formatEventTitle(event);
  const description = formatEventDescription(event);

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${icon} ${title}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: description,
      },
    },
  ];

  // Add fields section
  const fields = buildSlackFields(event);
  if (fields.length > 0) {
    blocks.push({
      type: "section",
      fields,
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Source: *${event.sourceSkill}* | ${event.timestamp}`,
      },
    ],
  });

  return { blocks };
}

// ─── Plain Text Formatter ──────────────────────────────────────────

export function formatAlertPlainText(event: CodaEvent): string {
  const icon = SEVERITY_ICONS[event.severity] ?? "[INFO]";
  const title = formatEventTitle(event);
  const description = formatEventDescription(event);

  let text = `${icon} ${title}`;
  if (description) {
    text += `\n${description}`;
  }
  text += `\nSource: ${event.sourceSkill} | ${event.timestamp}`;
  return text;
}

// ─── Event-Type-Specific Formatters ────────────────────────────────

export function formatUnifiNewClient(event: CodaEvent): string {
  const p = event.payload;
  return `New device on network: ${p.hostname ?? "Unknown"} (${p.mac ?? "?"}) — IP: ${p.ipAddress ?? "unknown"}`;
}

export function formatUnifiBandwidthSpike(event: CodaEvent): string {
  const p = event.payload;
  return `Bandwidth spike detected: ${p.hostname ?? "Unknown device"} — ${p.currentMbps ?? "?"}Mbps (baseline: ${p.baselineMbps ?? "?"}Mbps)`;
}

export function formatUnifiDeviceOffline(event: CodaEvent): string {
  const p = event.payload;
  return `Device offline: ${p.hostname ?? p.mac ?? "Unknown"} — last seen: ${p.lastSeen ?? "unknown"}`;
}

export function formatEmailUrgent(event: CodaEvent): string {
  const p = event.payload;
  return `Urgent email from ${p.from ?? "unknown"}: ${p.subject ?? "(no subject)"}`;
}

export function formatReminderDue(event: CodaEvent): string {
  const p = event.payload;
  return `Reminder due: ${p.title ?? "untitled"} (due: ${p.dueAt ?? "now"})`;
}

// ─── Helpers ───────────────────────────────────────────────────────

/** Event-specific formatters keyed by event type. */
const EVENT_FORMATTERS: Record<
  string,
  (event: CodaEvent) => string
> = {
  "alert.unifi.new_client": formatUnifiNewClient,
  "alert.unifi.bandwidth_spike": formatUnifiBandwidthSpike,
  "alert.unifi.device_offline": formatUnifiDeviceOffline,
  "alert.email.urgent": formatEmailUrgent,
  "alert.reminder.due": formatReminderDue,
};

function formatEventTitle(event: CodaEvent): string {
  // Use a human-readable title from the event type
  return event.eventType
    .replace("alert.", "")
    .replace(/\./g, " — ")
    .replace(/_/g, " ");
}

function formatEventDescription(event: CodaEvent): string {
  const formatter = EVENT_FORMATTERS[event.eventType];
  if (formatter) {
    return formatter(event);
  }
  // Fallback: stringify payload
  return JSON.stringify(event.payload);
}

function buildEmbedFields(
  event: CodaEvent
): Array<{ name: string; value: string; inline?: boolean }> {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

  fields.push({
    name: "Severity",
    value: event.severity.toUpperCase(),
    inline: true,
  });

  fields.push({
    name: "Event Type",
    value: event.eventType,
    inline: true,
  });

  // Add payload fields (limit to avoid overly large embeds)
  const payloadKeys = Object.keys(event.payload).slice(0, 5);
  for (const key of payloadKeys) {
    const value = event.payload[key];
    fields.push({
      name: key,
      value: String(value ?? "—"),
      inline: true,
    });
  }

  return fields;
}

function buildSlackFields(
  event: CodaEvent
): Array<{ type: string; text: string }> {
  const fields: Array<{ type: string; text: string }> = [];

  fields.push({
    type: "mrkdwn",
    text: `*Severity:* ${event.severity.toUpperCase()}`,
  });

  fields.push({
    type: "mrkdwn",
    text: `*Event Type:* ${event.eventType}`,
  });

  return fields;
}
