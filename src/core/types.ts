/**
 * Core types for file processing pipeline
 */

/**
 * Inbound attachment from user message
 */
export interface InboundAttachment {
  /** Original filename */
  name: string;
  /** Local path where file was downloaded */
  localPath: string;
  /** MIME type if available */
  mimeType?: string;
  /** File size in bytes */
  sizeBytes: number;
}

/**
 * Outbound file to be sent back to user
 */
export interface OutboundFile {
  /** Filename to use when sending */
  name: string;
  /** Local path to the file */
  path: string;
  /** MIME type if available */
  mimeType?: string;
}

/**
 * Orchestrator response containing text and optional file attachments
 */
export interface OrchestratorResponse {
  /** Text response to send to user */
  text: string;
  /** Optional files to attach to response */
  files?: OutboundFile[];
  /** Whether a confirmation is pending (temp dir should not be cleaned up yet) */
  pendingConfirmation?: boolean;
}
