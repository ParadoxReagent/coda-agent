/**
 * Validates tool call inputs against their JSON Schema definitions.
 * Enforces type safety, required fields, and max string lengths to
 * prevent injection and abuse via oversized payloads.
 */

const DEFAULT_MAX_STRING_LENGTH = 10_000;

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
  sanitizedInput?: Record<string, unknown>;
}

interface SchemaProperty {
  type?: string;
  enum?: unknown[];
  items?: SchemaProperty;
  description?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
}

export class ToolInputValidator {
  /**
   * Validate a tool call input against its declared JSON Schema.
   * Returns sanitized input on success, or errors on failure.
   */
  static validate(
    _toolName: string,
    inputSchema: Record<string, unknown>,
    input: Record<string, unknown>
  ): ValidationResult {
    const errors: string[] = [];
    const sanitized: Record<string, unknown> = {};

    const properties = (inputSchema.properties ?? {}) as Record<string, SchemaProperty>;
    const required = (inputSchema.required ?? []) as string[];

    // Check required fields
    for (const key of required) {
      if (input[key] === undefined || input[key] === null) {
        errors.push(`Missing required field: ${key}`);
      }
    }

    // Validate each provided field
    for (const [key, value] of Object.entries(input)) {
      const schema = properties[key];

      if (!schema) {
        // Allow unknown fields but pass them through
        sanitized[key] = value;
        continue;
      }

      const fieldErrors = this.validateField(key, value, schema);
      if (fieldErrors.length > 0) {
        errors.push(...fieldErrors);
      } else {
        sanitized[key] = value;
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true, sanitizedInput: sanitized };
  }

  private static validateField(
    key: string,
    value: unknown,
    schema: SchemaProperty
  ): string[] {
    const errors: string[] = [];

    if (value === undefined || value === null) {
      return errors;
    }

    if (schema.type) {
      switch (schema.type) {
        case "string": {
          if (typeof value !== "string") {
            errors.push(`Field "${key}" must be a string, got ${typeof value}`);
            break;
          }
          const maxLen = schema.maxLength ?? DEFAULT_MAX_STRING_LENGTH;
          if (value.length > maxLen) {
            errors.push(
              `Field "${key}" exceeds maximum length (${value.length} > ${maxLen})`
            );
          }
          if (schema.enum && !schema.enum.includes(value)) {
            errors.push(
              `Field "${key}" must be one of: ${schema.enum.join(", ")}`
            );
          }
          break;
        }

        case "number": {
          if (typeof value !== "number" || Number.isNaN(value)) {
            errors.push(`Field "${key}" must be a number, got ${typeof value}`);
            break;
          }
          if (schema.minimum !== undefined && value < schema.minimum) {
            errors.push(
              `Field "${key}" must be >= ${schema.minimum}`
            );
          }
          if (schema.maximum !== undefined && value > schema.maximum) {
            errors.push(
              `Field "${key}" must be <= ${schema.maximum}`
            );
          }
          break;
        }

        case "boolean": {
          if (typeof value !== "boolean") {
            errors.push(`Field "${key}" must be a boolean, got ${typeof value}`);
          }
          break;
        }

        case "array": {
          if (!Array.isArray(value)) {
            errors.push(`Field "${key}" must be an array, got ${typeof value}`);
            break;
          }
          if (schema.minItems !== undefined && value.length < schema.minItems) {
            errors.push(
              `Field "${key}" must have at least ${schema.minItems} items`
            );
          }
          if (schema.maxItems !== undefined && value.length > schema.maxItems) {
            errors.push(
              `Field "${key}" must have at most ${schema.maxItems} items`
            );
          }
          // Validate array item types if specified
          if (schema.items?.type) {
            for (let i = 0; i < value.length; i++) {
              const itemErrors = this.validateField(
                `${key}[${i}]`,
                value[i],
                schema.items
              );
              errors.push(...itemErrors);
            }
          }
          break;
        }

        case "object": {
          if (typeof value !== "object" || Array.isArray(value)) {
            errors.push(`Field "${key}" must be an object, got ${typeof value}`);
          }
          break;
        }
      }
    }

    return errors;
  }
}
