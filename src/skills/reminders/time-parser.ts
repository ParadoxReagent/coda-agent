import * as chrono from "chrono-node";

export interface ParsedTime {
  date: Date;
  text: string;
  isRecurring: boolean;
  cronExpression?: string;
}

/**
 * Parse natural language time expressions into dates.
 * Handles relative ("in 2 hours"), absolute ("Friday at 3pm"),
 * and recurring ("every Monday at 9am") expressions.
 */
export function parseNaturalTime(
  input: string,
  timezone: string,
  referenceDate?: Date
): ParsedTime | null {
  const ref = referenceDate ?? new Date();

  // Check for recurring patterns
  const recurringMatch = parseRecurring(input, timezone, ref);
  if (recurringMatch) {
    return recurringMatch;
  }

  // Use chrono-node for standard time parsing
  const results = chrono.parse(input, { instant: ref, timezone });

  if (results.length === 0) {
    return null;
  }

  const parsed = results[0]!;
  const date = parsed.start.date();

  // Generate human-readable text
  const text = formatHumanReadable(date, ref);

  return {
    date,
    text,
    isRecurring: false,
  };
}

function parseRecurring(
  input: string,
  _timezone: string,
  ref: Date
): ParsedTime | null {
  const lowerInput = input.toLowerCase();

  // "every day at HH:MM"
  const dailyMatch = lowerInput.match(
    /every\s+day\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i
  );
  if (dailyMatch) {
    let hours = parseInt(dailyMatch[1]!, 10);
    const minutes = parseInt(dailyMatch[2] ?? "0", 10);
    const ampm = dailyMatch[3]?.toLowerCase();

    if (ampm === "pm" && hours < 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;

    const next = new Date(ref);
    next.setHours(hours, minutes, 0, 0);
    if (next <= ref) {
      next.setDate(next.getDate() + 1);
    }

    return {
      date: next,
      text: `daily at ${formatTime(hours, minutes)}`,
      isRecurring: true,
      cronExpression: `${minutes} ${hours} * * *`,
    };
  }

  // "every <weekday> at HH:MM"
  const weeklyMatch = lowerInput.match(
    /every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i
  );
  if (weeklyMatch) {
    const dayName = weeklyMatch[1]!.toLowerCase();
    let hours = parseInt(weeklyMatch[2]!, 10);
    const minutes = parseInt(weeklyMatch[3] ?? "0", 10);
    const ampm = weeklyMatch[4]?.toLowerCase();

    if (ampm === "pm" && hours < 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;

    const dayMap: Record<string, number> = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };
    const targetDay = dayMap[dayName]!;

    const next = new Date(ref);
    const currentDay = next.getDay();
    let daysUntil = targetDay - currentDay;
    if (daysUntil < 0) daysUntil += 7;
    if (daysUntil === 0) {
      // Same day — check if time has passed
      next.setHours(hours, minutes, 0, 0);
      if (next <= ref) {
        daysUntil = 7;
      }
    }
    next.setDate(ref.getDate() + daysUntil);
    next.setHours(hours, minutes, 0, 0);

    return {
      date: next,
      text: `every ${dayName} at ${formatTime(hours, minutes)}`,
      isRecurring: true,
      cronExpression: `${minutes} ${hours} * * ${targetDay}`,
    };
  }

  // "every N hours/minutes"
  const intervalMatch = lowerInput.match(
    /every\s+(\d+)\s*(hour|minute|min)s?/i
  );
  if (intervalMatch) {
    const amount = parseInt(intervalMatch[1]!, 10);
    const unit = intervalMatch[2]!.toLowerCase();

    const next = new Date(ref);
    if (unit === "hour") {
      next.setHours(next.getHours() + amount);
    } else {
      next.setMinutes(next.getMinutes() + amount);
    }

    const unitLabel = unit.startsWith("min") ? "minute" : "hour";
    const cronExpr =
      unitLabel === "hour"
        ? `0 */${amount} * * *`
        : `*/${amount} * * * *`;

    return {
      date: next,
      text: `every ${amount} ${unitLabel}${amount > 1 ? "s" : ""}`,
      isRecurring: true,
      cronExpression: cronExpr,
    };
  }

  return null;
}

function formatTime(hours: number, minutes: number): string {
  const ampm = hours >= 12 ? "PM" : "AM";
  const h = hours % 12 || 12;
  const m = minutes.toString().padStart(2, "0");
  return `${h}:${m} ${ampm}`;
}

function formatHumanReadable(date: Date, ref: Date): string {
  const diffMs = date.getTime() - ref.getTime();
  const diffMins = Math.round(diffMs / 60_000);
  const diffHours = Math.round(diffMs / 3_600_000);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `in ${diffMins} minute${diffMins > 1 ? "s" : ""}`;
  if (diffHours < 24) return `in ${diffHours} hour${diffHours > 1 ? "s" : ""}`;

  const days = Math.round(diffMs / 86_400_000);
  if (days === 1) return "tomorrow";
  if (days < 7)
    return `on ${date.toLocaleDateString("en-US", { weekday: "long" })}`;

  return `on ${date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== ref.getFullYear() ? "numeric" : undefined,
  })}`;
}
