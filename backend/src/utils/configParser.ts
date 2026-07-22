import YAML from 'yaml';
import TOML from '@iarna/toml';

export type ConfigFormat = 'json' | 'yaml' | 'toml';

export interface ParseResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    message: string;
    line?: number;
    column?: number;
  };
}

export interface FormatOptions {
  indent?: number; // spaces for indentation (default: 2)
  sortKeys?: boolean; // sort object keys alphabetically
}

/**
 * ConfigParser provides parsing and formatting for JSON, YAML, and TOML configuration files.
 * Supports round-trip validation to ensure data integrity.
 */
class ConfigParser {
  /**
   * Parse configuration content into a structured object.
   * @param content - The configuration file content as a string
   * @param format - The format of the configuration ('json', 'yaml', or 'toml')
   * @returns ParseResult with success status, data, or error information
   */
  parse<T = unknown>(content: string, format: ConfigFormat): ParseResult<T> {
    try {
      let data: T;

      switch (format) {
        case 'json':
          data = JSON.parse(content) as T;
          break;

        case 'yaml':
          data = YAML.parse(content) as T;
          break;

        case 'toml':
          data = TOML.parse(content) as T;
          break;

        default:
          throw new Error(`Unsupported format: ${format}`);
      }

      return { success: true, data };
    } catch (error) {
      const err = error as Error & { lineNumber?: number; columnNumber?: number };

      return {
        success: false,
        error: {
          message: err.message,
          line: err.lineNumber,
          column: err.columnNumber,
        },
      };
    }
  }

  /**
   * Format a data object into a configuration string.
   * @param data - The data object to format
   * @param format - The target format ('json', 'yaml', or 'toml')
   * @param options - Formatting options (indent, sortKeys)
   * @returns Formatted configuration string
   */
  format(data: unknown, format: ConfigFormat, options: FormatOptions = {}): string {
    const indent = options.indent ?? 2;

    // Sort keys if requested
    const processedData = options.sortKeys ? sortObjectKeys(data) : data;

    switch (format) {
      case 'json':
        return JSON.stringify(processedData, null, indent);

      case 'yaml':
        return YAML.stringify(processedData, { indent });

      case 'toml':
        return TOML.stringify(processedData as TOML.JsonMap);

      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }

  /**
   * Validate that a configuration can be parsed, formatted, and re-parsed
   * without data loss (round-trip validation).
   * @param content - The configuration content to validate
   * @param format - The format of the configuration
   * @returns true if round-trip validation succeeds, false otherwise
   */
  validateRoundTrip(content: string, format: ConfigFormat): boolean {
    try {
      const parseResult = this.parse(content, format);
      if (!parseResult.success) return false;

      const formatted = this.format(parseResult.data, format);
      const reparsed = this.parse(formatted, format);

      if (!reparsed.success) return false;

      // Deep equality check
      return JSON.stringify(parseResult.data) === JSON.stringify(reparsed.data);
    } catch {
      return false;
    }
  }
}

/**
 * Recursively sort object keys alphabetically.
 * Arrays and nested objects are processed recursively.
 * @param obj - The object to sort
 * @returns A new object with sorted keys
 */
function sortObjectKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }

  if (obj !== null && typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(obj).sort();

    for (const key of keys) {
      sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
    }

    return sorted;
  }

  return obj;
}

// Export singleton instance
export const configParser = new ConfigParser();
