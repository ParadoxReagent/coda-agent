export type EmailCategory =
  | "urgent"
  | "needs_response"
  | "informational"
  | "low_priority";

export interface EmailMetadata {
  // Gmail API fields
  messageId: string;
  labels?: string[];

  // IMAP compatibility fields
  uid?: number;
  folder?: string;
  flags?: string[];

  // Common fields
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  date: string;
  snippet: string;
  category: EmailCategory;
}

export interface EmailCategorizationRules {
  urgentSenders: string[];
  urgentKeywords: string[];
  knownContacts: string[];
}
