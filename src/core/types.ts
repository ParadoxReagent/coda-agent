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

/**
 * Extract output files from a tool result JSON string.
 * Looks for { output_files: [...] } in the result string.
 */
export function extractOutputFiles(result: string): OutboundFile[] {
  try {
    const parsed = JSON.parse(result);
    if (parsed.output_files && Array.isArray(parsed.output_files)) {
      return parsed.output_files.filter(
        (f: unknown): f is OutboundFile =>
          typeof f === "object" &&
          f !== null &&
          "name" in f &&
          "path" in f &&
          typeof f.name === "string" &&
          typeof f.path === "string"
      );
    }
  } catch {
    // Result is not JSON or doesn't contain output_files
  }
  return [];
}
