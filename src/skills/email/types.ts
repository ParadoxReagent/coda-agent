export type EmailCategory =
  | "urgent"
  | "needs_response"
  | "informational"
  | "low_priority";

export interface EmailMetadata {
  uid: number;
  messageId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  date: string;
  snippet: string;
  flags: string[];
  folder: string;
  category: EmailCategory;
}

export interface EmailCategorizationRules {
  urgentSenders: string[];
  urgentKeywords: string[];
  knownContacts: string[];
}
