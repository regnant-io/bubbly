/**
 * ConfigParser Usage Examples
 * 
 * This file demonstrates how to use the ConfigParser utility
 * for parsing and formatting JSON, YAML, and TOML configuration files.
 */

import { configParser } from './configParser';

// Example 1: Parsing JSON configuration
function parseJsonExample() {
  const jsonContent = `{
    "server": {
      "host": "localhost",
      "port": 3000
    },
    "database": {
      "url": "postgresql://localhost/mydb"
    }
  }`;

  const result = configParser.parse(jsonContent, 'json');

  if (result.success) {
    console.log('Parsed JSON:', result.data);
  } else {
    console.error('Parse error:', result.error?.message);
    console.error('Line:', result.error?.line);
    console.error('Column:', result.error?.column);
  }
}

// Example 2: Parsing YAML configuration
function parseYamlExample() {
  const yamlContent = `
server:
  host: localhost
  port: 3000
database:
  url: postgresql://localhost/mydb
`;

  const result = configParser.parse(yamlContent, 'yaml');

  if (result.success) {
    console.log('Parsed YAML:', result.data);
  } else {
    console.error('Parse error:', result.error?.message);
  }
}

// Example 3: Parsing TOML configuration
function parseTomlExample() {
  const tomlContent = `
[server]
host = "localhost"
port = 3000

[database]
url = "postgresql://localhost/mydb"
`;

  const result = configParser.parse(tomlContent, 'toml');

  if (result.success) {
    console.log('Parsed TOML:', result.data);
  } else {
    console.error('Parse error:', result.error?.message);
  }
}

// Example 4: Formatting configuration with default options
function formatDefaultExample() {
  const config = {
    server: {
      host: 'localhost',
      port: 3000,
    },
    database: {
      url: 'postgresql://localhost/mydb',
    },
  };

  const jsonOutput = configParser.format(config, 'json');
  console.log('JSON output:\n', jsonOutput);

  const yamlOutput = configParser.format(config, 'yaml');
  console.log('YAML output:\n', yamlOutput);

  const tomlOutput = configParser.format(config, 'toml');
  console.log('TOML output:\n', tomlOutput);
}

// Example 5: Formatting with custom indentation
function formatCustomIndentExample() {
  const config = {
    name: 'MyApp',
    version: '1.0.0',
  };

  // 4-space indentation
  const json4Spaces = configParser.format(config, 'json', { indent: 4 });
  console.log('JSON with 4 spaces:\n', json4Spaces);

  // 2-space indentation (default)
  const json2Spaces = configParser.format(config, 'json', { indent: 2 });
  console.log('JSON with 2 spaces:\n', json2Spaces);
}

// Example 6: Formatting with sorted keys
function formatSortedKeysExample() {
  const config = {
    zebra: 'last',
    apple: 'first',
    banana: 'second',
    nested: {
      zoo: 'last',
      ant: 'first',
    },
  };

  // Without sorting
  const unsorted = configParser.format(config, 'json');
  console.log('Unsorted:\n', unsorted);

  // With sorting
  const sorted = configParser.format(config, 'json', { sortKeys: true });
  console.log('Sorted:\n', sorted);
}

// Example 7: Round-trip validation
function roundTripValidationExample() {
  const jsonContent = '{"name": "test", "value": 42}';
  const yamlContent = 'name: test\nvalue: 42\n';
  const tomlContent = 'name = "test"\nvalue = 42\n';

  console.log('JSON round-trip valid:', configParser.validateRoundTrip(jsonContent, 'json'));
  console.log('YAML round-trip valid:', configParser.validateRoundTrip(yamlContent, 'yaml'));
  console.log('TOML round-trip valid:', configParser.validateRoundTrip(tomlContent, 'toml'));

  // Invalid content
  const invalidJson = '{invalid}';
  console.log('Invalid JSON round-trip:', configParser.validateRoundTrip(invalidJson, 'json'));
}

// Example 8: Type-safe parsing with TypeScript
interface AppConfig {
  server: {
    host: string;
    port: number;
  };
  database: {
    url: string;
  };
}

function typeSafeParsingExample() {
  const jsonContent = `{
    "server": {
      "host": "localhost",
      "port": 3000
    },
    "database": {
      "url": "postgresql://localhost/mydb"
    }
  }`;

  const result = configParser.parse<AppConfig>(jsonContent, 'json');

  if (result.success && result.data) {
    // TypeScript knows the structure of result.data
    console.log('Server host:', result.data.server.host);
    console.log('Server port:', result.data.server.port);
    console.log('Database URL:', result.data.database.url);
  }
}

// Example 9: Converting between formats
function convertFormatsExample() {
  const jsonContent = '{"name": "test", "value": 42}';

  // Parse JSON
  const parseResult = configParser.parse(jsonContent, 'json');

  if (parseResult.success && parseResult.data) {
    // Convert to YAML
    const yamlOutput = configParser.format(parseResult.data, 'yaml');
    console.log('Converted to YAML:\n', yamlOutput);

    // Convert to TOML
    const tomlOutput = configParser.format(parseResult.data, 'toml');
    console.log('Converted to TOML:\n', tomlOutput);
  }
}

// Example 10: Error handling
function errorHandlingExample() {
  const invalidJson = '{invalid json}';
  const result = configParser.parse(invalidJson, 'json');

  if (!result.success) {
    console.error('Failed to parse configuration');
    console.error('Error message:', result.error?.message);

    if (result.error?.line !== undefined) {
      console.error('Error at line:', result.error.line);
    }

    if (result.error?.column !== undefined) {
      console.error('Error at column:', result.error.column);
    }

    // Handle the error appropriately
    // - Show user-friendly error message
    // - Log to error tracking service
    // - Provide fallback configuration
  }
}

// Run examples (uncomment to test)
// parseJsonExample();
// parseYamlExample();
// parseTomlExample();
// formatDefaultExample();
// formatCustomIndentExample();
// formatSortedKeysExample();
// roundTripValidationExample();
// typeSafeParsingExample();
// convertFormatsExample();
// errorHandlingExample();
