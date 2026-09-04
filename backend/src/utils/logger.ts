import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

/**
 * Logger configuration interface
 */
export interface LoggerConfig {
  logDir: string;
  maxFileSize: number; // bytes
  maxFiles: number; // days
  level: 'error' | 'warn' | 'info' | 'debug';
}

/**
 * Context object for structured logging
 */
export interface LogContext {
  sessionId?: string;
  correlationId?: string;
  tool?: string;
  iteration?: number;
  [key: string]: unknown;
}

/**
 * Logger class providing structured logging with rotation and correlation tracking
 */
export class Logger {
  private winstonLogger: winston.Logger;
  private context: LogContext;

  constructor(config: LoggerConfig, context: LogContext = {}) {
    this.context = context;

    // Determine if we're in production based on NODE_ENV
    const isProduction = process.env.NODE_ENV === 'production';

    // Console format: pretty for dev, JSON for prod
    const consoleFormat = isProduction
      ? winston.format.json()
      : winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length > 0 ? JSON.stringify(meta, null, 2) : '';
            return `${timestamp} [${level}]: ${message} ${metaStr}`;
          })
        );

    // File format: always JSON for structured logging
    const fileFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.json()
    );

    // Create winston logger instance
    this.winstonLogger = winston.createLogger({
      level: config.level,
      defaultMeta: this.context,
      transports: [
        // Console transport
        new winston.transports.Console({
          format: consoleFormat,
        }),
        // Daily rotating file transport
        new DailyRotateFile({
          filename: path.join(config.logDir, 'bubbly-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          maxSize: config.maxFileSize,
          maxFiles: `${config.maxFiles}d`, // Keep logs for N days
          format: fileFormat,
          auditFile: path.join(config.logDir, '.audit.json'),
        }),
      ],
    });
  }

  /**
   * Log an error message
   */
  error(message: string, context?: LogContext): void {
    this.winstonLogger.error(message, { ...this.context, ...context });
  }

  /**
   * Log a warning message
   */
  warn(message: string, context?: LogContext): void {
    this.winstonLogger.warn(message, { ...this.context, ...context });
  }

  /**
   * Log an info message
   */
  info(message: string, context?: LogContext): void {
    this.winstonLogger.info(message, { ...this.context, ...context });
  }

  /**
   * Log a debug message
   */
  debug(message: string, context?: LogContext): void {
    this.winstonLogger.debug(message, { ...this.context, ...context });
  }

  /**
   * Create a child logger with inherited context
   * Child loggers inherit all parent context and can add additional context
   */
  child(context: LogContext): Logger {
    const childContext = { ...this.context, ...context };
    const childLogger = Object.create(this);
    childLogger.context = childContext;
    childLogger.winstonLogger = this.winstonLogger.child(childContext);
    return childLogger;
  }

  /**
   * Generate a new correlation ID (UUID v4)
   */
  static generateCorrelationId(): string {
    return uuidv4();
  }
}

/**
 * Default logger configuration
 */
const defaultConfig: LoggerConfig = {
  logDir: process.env.BUBBLY_LOG_DIR || path.join(process.cwd(), 'logs'),
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 14, // 14 days retention
  level: (process.env.LOG_LEVEL as LoggerConfig['level']) || 'info',
};

/**
 * Global logger instance
 * Can be imported and used throughout the application
 */
export const logger = new Logger(defaultConfig);

/**
 * Create a logger with custom configuration
 */
export function createLogger(config: Partial<LoggerConfig>, context?: LogContext): Logger {
  return new Logger({ ...defaultConfig, ...config }, context);
}
