import { logger } from './logger';

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Validates settings before saving
 */
export async function validateSettings(
  updates: Record<string, string>,
  currentSettings: Record<string, string>
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];

  // Validate workspace path (required)
  if (updates.workspacePath !== undefined) {
    const workspacePath = updates.workspacePath.trim();
    if (!workspacePath) {
      errors.push({
        field: 'workspacePath',
        message: 'Workspace path is required',
      });
    } else if (!isValidPath(workspacePath)) {
      errors.push({
        field: 'workspacePath',
        message: 'Workspace path must be an absolute path',
      });
    }
  }

  // Validate Anthropic API key format
  if (updates.anthropicApiKey !== undefined) {
    const apiKey = updates.anthropicApiKey.trim();
    if (apiKey && !isValidAnthropicApiKey(apiKey)) {
      errors.push({
        field: 'anthropicApiKey',
        message: 'Invalid API key format. Should start with "sk-ant-"',
      });
    }

    // Test Claude API key validity if it's being changed and is not empty
    if (apiKey && apiKey !== currentSettings.anthropicApiKey) {
      logger.info('Testing Claude API key validity');
      const isValid = await testClaudeApiKey(apiKey);
      if (!isValid) {
        errors.push({
          field: 'anthropicApiKey',
          message: 'API key is invalid or cannot connect to Claude API',
        });
      }
    }
  }

  // Validate Google Gemini API key
  if (updates.geminiApiKey !== undefined) {
    const apiKey = updates.geminiApiKey.trim();
    // Test Gemini API key validity if it's being changed and is not empty
    if (apiKey && apiKey !== currentSettings.geminiApiKey) {
      logger.info('Testing Gemini API key validity');
      const isValid = await testGeminiApiKey(apiKey);
      if (!isValid) {
        errors.push({
          field: 'geminiApiKey',
          message: 'API key is invalid or cannot connect to the Gemini API',
        });
      }
    }
  }

  // Validate Ollama base URL
  if (updates.ollamaBaseUrl !== undefined) {
    const baseUrl = updates.ollamaBaseUrl.trim();
    if (!baseUrl) {
      errors.push({
        field: 'ollamaBaseUrl',
        message: 'Ollama base URL is required',
      });
    } else if (!isValidUrl(baseUrl)) {
      errors.push({
        field: 'ollamaBaseUrl',
        message: 'Invalid URL format',
      });
    } else if (baseUrl !== currentSettings.ollamaBaseUrl) {
      // Test Ollama connectivity when URL changes
      logger.info('Testing Ollama connectivity', { baseUrl });
      const isConnected = await testOllamaConnectivity(baseUrl);
      if (!isConnected) {
        errors.push({
          field: 'ollamaBaseUrl',
          message: 'Cannot connect to Ollama at this URL. Make sure Ollama is running.',
        });
      }
    }
  }

  // Validate retry configuration
  if (updates.ollamaRetryMaxAttempts !== undefined) {
    const val = parseInt(updates.ollamaRetryMaxAttempts, 10);
    if (isNaN(val) || val < 1 || val > 10) {
      errors.push({
        field: 'ollamaRetryMaxAttempts',
        message: 'Max retry attempts must be between 1 and 10',
      });
    }
  }

  if (updates.ollamaRetryInitialDelayMs !== undefined) {
    const val = parseInt(updates.ollamaRetryInitialDelayMs, 10);
    if (isNaN(val) || val < 100 || val > 5000) {
      errors.push({
        field: 'ollamaRetryInitialDelayMs',
        message: 'Initial retry delay must be between 100 and 5000 milliseconds',
      });
    }
  }

  if (updates.ollamaRetryBackoffMultiplier !== undefined) {
    const val = parseFloat(updates.ollamaRetryBackoffMultiplier);
    if (isNaN(val) || val < 1.5 || val > 3.0) {
      errors.push({
        field: 'ollamaRetryBackoffMultiplier',
        message: 'Backoff multiplier must be between 1.5 and 3.0',
      });
    }
  }

  // Validate provider selection
  if (updates.defaultProvider !== undefined) {
    if (!['claude', 'ollama', 'gemini'].includes(updates.defaultProvider)) {
      errors.push({
        field: 'defaultProvider',
        message: 'Provider must be "claude", "ollama", or "gemini"',
      });
    }
  }

  // Validate theme
  if (updates.theme !== undefined) {
    if (!['light', 'dark', 'system'].includes(updates.theme)) {
      errors.push({
        field: 'theme',
        message: 'Theme must be "light", "dark", or "system"',
      });
    }
  }

  // Validate boolean settings
  const booleanFields = [
    'requireApprovalForWrites',
    'requireApprovalForShell',
    'ollamaEnableThinking',
    'autoValidate',
    'multiAgentSpec',
    'autoContextMigration',
    'ollamaAutoNumCtx',
    'revealRightPanelOnDiff',
    'specDocsAsMarkdown',
    'wordWrap',
    'formatOnSave',
    'autoSave',
    'computerControlEnabled',
    'browserControlEnabled',
  ];

  for (const field of booleanFields) {
    if (updates[field] !== undefined) {
      if (!['true', 'false'].includes(updates[field])) {
        errors.push({
          field,
          message: `${field} must be "true" or "false"`,
        });
      }
    }
  }

  // Validate context migration threshold (fraction of usable context).
  if (updates.contextMigrationThreshold !== undefined) {
    const val = parseFloat(updates.contextMigrationThreshold);
    if (isNaN(val) || val < 0.5 || val > 0.95) {
      errors.push({
        field: 'contextMigrationThreshold',
        message: 'Migration threshold must be between 0.5 and 0.95',
      });
    }
  }

  const valid = errors.length === 0;
  if (!valid) {
    logger.warn('Settings validation failed', { errors });
  } else {
    logger.info('Settings validation passed');
  }

  return { valid, errors };
}

/**
 * Check if a path looks like an absolute path
 */
function isValidPath(path: string): boolean {
  // Unix absolute path starts with /
  // Windows absolute path starts with drive letter (C:\ or C:/)
  return /^([a-zA-Z]:[\\\/]|[\/])/.test(path);
}

/**
 * Check if API key has the correct format
 */
function isValidAnthropicApiKey(apiKey: string): boolean {
  // Anthropic API keys start with "sk-ant-"
  return apiKey.startsWith('sk-ant-') && apiKey.length > 20;
}

/**
 * Check if URL is valid
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Test Claude API key validity by making a minimal API call
 */
async function testClaudeApiKey(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'test' }],
      }),
    });

    // If we get a 200 or 400 (bad request but auth worked), the key is valid
    // 401 means unauthorized (invalid key)
    // 403 means forbidden (invalid key or no access)
    if (response.status === 200 || response.status === 400) {
      logger.info('Claude API key validation successful');
      return true;
    }

    logger.warn('Claude API key validation failed', { status: response.status });
    return false;
  } catch (error) {
    logger.error('Claude API key validation error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Test Google Gemini API key validity via a lightweight models list call.
 */
async function testGeminiApiKey(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      logger.info('Gemini API key validation successful');
      return true;
    }
    logger.warn('Gemini API key validation failed', { status: response.status });
    return false;
  } catch (error) {
    logger.error('Gemini API key validation error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Test Ollama connectivity by checking the /api/tags endpoint
 */
async function testOllamaConnectivity(baseUrl: string): Promise<boolean> {
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/tags`;
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });

    if (response.ok) {
      logger.info('Ollama connectivity test successful', { baseUrl });
      return true;
    }

    logger.warn('Ollama connectivity test failed', {
      baseUrl,
      status: response.status,
    });
    return false;
  } catch (error) {
    logger.error('Ollama connectivity test error', {
      baseUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
