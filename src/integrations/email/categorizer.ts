import type {
  EmailMetadata,
  EmailCategory,
  EmailCategorizationRules,
} from "./types.js";

/**
 * Rules-based email categorization. No LLM calls — fast path only.
 *
 * Priority order:
 * 1. Urgent senders/keywords → "urgent"
 * 2. Mailing list detection → "low_priority"
 * 3. Known contact direct email → "needs_response"
 * 4. Default → "informational"
 */
export function categorizeEmail(
  email: Pick<EmailMetadata, "from" | "to" | "cc" | "subject" | "snippet">,
  rules: EmailCategorizationRules
): EmailCategory {
  const fromLower = email.from.toLowerCase();
  const subjectLower = email.subject.toLowerCase();
  const snippetLower = email.snippet.toLowerCase();

  // 1. Check urgent senders
  for (const sender of rules.urgentSenders) {
    if (fromLower.includes(sender.toLowerCase())) {
      return "urgent";
    }
  }

  // 2. Check urgent keywords in subject or snippet
  for (const keyword of rules.urgentKeywords) {
    const kw = keyword.toLowerCase();
    if (subjectLower.includes(kw) || snippetLower.includes(kw)) {
      return "urgent";
    }
  }

  // 3. Check mailing list indicators (common patterns in from/subject)
  if (isMailingList(email)) {
    return "low_priority";
  }

  // 4. Check known contacts → likely needs response
  for (const contact of rules.knownContacts) {
    if (fromLower.includes(contact.toLowerCase())) {
      return "needs_response";
    }
  }

  // 5. Default
  return "informational";
}

function isMailingList(
  email: Pick<EmailMetadata, "from" | "to" | "cc">
): boolean {
  const from = email.from.toLowerCase();

  // Common mailing list sender patterns
  if (
    from.includes("noreply") ||
    from.includes("no-reply") ||
    from.includes("notifications@") ||
    from.includes("newsletter@") ||
    from.includes("digest@") ||
    from.includes("updates@") ||
    from.includes("mailer-daemon") ||
    from.includes("donotreply")
  ) {
    return true;
  }

  // Large CC lists often indicate mailing lists
  if (email.cc.length > 10) {
    return true;
  }

  return false;
}
