import { configParser, ConfigFormat, ParseResult } from './configParser';

describe('ConfigParser', () => {
  describe('JSON parsing', () => {
    it('should parse valid JSON', () => {
      const content = '{"name": "test", "value": 42}';
      const result = configParser.parse(content, 'json');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ name: 'test', value: 42 });
      expect(result.error).toBeUndefined();
    });

    it('should parse nested JSON objects', () => {
      const content = '{"user": {"name": "Alice", "age": 30}, "active": true}';
      const result = configParser.parse(content, 'json');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        user: { name: 'Alice', age: 30 },
        active: true,
      });
    });

    it('should parse JSON arrays', () => {
      const content = '{"items": [1, 2, 3], "tags": ["a", "b"]}';
      const result = configParser.parse(content, 'json');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        items: [1, 2, 3],
        tags: ['a', 'b'],
      });
    });

    it('should return error for invalid JSON', () => {
      const content = '{invalid json}';
      const result = configParser.parse(content, 'json');

      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('JSON');
    });
  });

  describe('YAML parsing', () => {
    it('should parse valid YAML', () => {
      const content = `
name: test
value: 42
`;
      const result = configParser.parse(content, 'yaml');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ name: 'test', value: 42 });
    });

    it('should parse nested YAML objects', () => {
      const content = `
user:
  name: Alice
  age: 30
active: true
`;
      const result = configParser.parse(content, 'yaml');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        user: { name: 'Alice', age: 30 },
        active: true,
      });
    });

    it('should parse YAML arrays', () => {
      const content = `
items:
  - 1
  - 2
  - 3
tags:
  - a
  - b
`;
      const result = configParser.parse(content, 'yaml');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        items: [1, 2, 3],
        tags: ['a', 'b'],
      });
    });

    it('should return error for invalid YAML', () => {
      const content = `
invalid:
  - item
  bad indentation
`;
      const result = configParser.parse(content, 'yaml');

      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
      expect(result.error).toBeDefined();
    });
  });

  describe('TOML parsing', () => {
    it('should parse valid TOML', () => {
      const content = `
name = "test"
value = 42
`;
      const result = configParser.parse(content, 'toml');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ name: 'test', value: 42 });
    });

    it('should parse TOML tables', () => {
      const content = `
[user]
name = "Alice"
age = 30

[settings]
active = true
`;
      const result = configParser.parse(content, 'toml');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        user: { name: 'Alice', age: 30 },
        settings: { active: true },
      });
    });

    it('should parse TOML arrays', () => {
      const content = `
items = [1, 2, 3]
tags = ["a", "b"]
`;
      const result = configParser.parse(content, 'toml');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        items: [1, 2, 3],
        tags: ['a', 'b'],
      });
    });

    it('should return error for invalid TOML', () => {
      const content = `
[invalid
name = "test"
`;
      const result = configParser.parse(content, 'toml');

      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
      expect(result.error).toBeDefined();
    });
  });

  describe('JSON formatting', () => {
    it('should format object to JSON with default indentation', () => {
      const data = { name: 'test', value: 42 };
      const result = configParser.format(data, 'json');

      expect(result).toBe('{\n  "name": "test",\n  "value": 42\n}');
    });

    it('should format object to JSON with custom indentation', () => {
      const data = { name: 'test', value: 42 };
      const result = configParser.format(data, 'json', { indent: 4 });

      expect(result).toBe('{\n    "name": "test",\n    "value": 42\n}');
    });

    it('should format nested objects to JSON', () => {
      const data = { user: { name: 'Alice', age: 30 }, active: true };
      const result = configParser.format(data, 'json');

      expect(result).toContain('"user"');
      expect(result).toContain('"name": "Alice"');
      expect(result).toContain('"age": 30');
      expect(result).toContain('"active": true');
    });

    it('should format arrays to JSON', () => {
      const data = { items: [1, 2, 3], tags: ['a', 'b'] };
      const result = configParser.format(data, 'json');

      expect(result).toContain('"items": [\n    1,\n    2,\n    3\n  ]');
      expect(result).toContain('"tags": [\n    "a",\n    "b"\n  ]');
    });

    it('should sort keys when sortKeys option is true', () => {
      const data = { zebra: 1, apple: 2, banana: 3 };
      const result = configParser.format(data, 'json', { sortKeys: true });

      const lines = result.split('\n');
      expect(lines[1]).toContain('apple');
      expect(lines[2]).toContain('banana');
      expect(lines[3]).toContain('zebra');
    });

    it('should sort nested object keys when sortKeys option is true', () => {
      const data = { z: { y: 1, x: 2 }, a: { c: 3, b: 4 } };
      const result = configParser.format(data, 'json', { sortKeys: true });

      expect(result.indexOf('"a"')).toBeLessThan(result.indexOf('"z"'));
      expect(result.indexOf('"b"')).toBeLessThan(result.indexOf('"c"'));
      expect(result.indexOf('"x"')).toBeLessThan(result.indexOf('"y"'));
    });
  });

  describe('YAML formatting', () => {
    it('should format object to YAML', () => {
      const data = { name: 'test', value: 42 };
      const result = configParser.format(data, 'yaml');

      expect(result).toContain('name: test');
      expect(result).toContain('value: 42');
    });

    it('should format nested objects to YAML', () => {
      const data = { user: { name: 'Alice', age: 30 }, active: true };
      const result = configParser.format(data, 'yaml');

      expect(result).toContain('user:');
      expect(result).toContain('name: Alice');
      expect(result).toContain('age: 30');
      expect(result).toContain('active: true');
    });

    it('should format arrays to YAML', () => {
      const data = { items: [1, 2, 3] };
      const result = configParser.format(data, 'yaml');

      expect(result).toContain('items:');
      expect(result).toMatch(/- 1/);
      expect(result).toMatch(/- 2/);
      expect(result).toMatch(/- 3/);
    });
  });

  describe('TOML formatting', () => {
    it('should format object to TOML', () => {
      const data = { name: 'test', value: 42 };
      const result = configParser.format(data, 'toml');

      expect(result).toContain('name = "test"');
      expect(result).toContain('value = 42');
    });

    it('should format nested objects to TOML tables', () => {
      const data = { user: { name: 'Alice', age: 30 } };
      const result = configParser.format(data, 'toml');

      expect(result).toContain('[user]');
      expect(result).toContain('name = "Alice"');
      expect(result).toContain('age = 30');
    });

    it('should format arrays to TOML', () => {
      const data = { items: [1, 2, 3] };
      const result = configParser.format(data, 'toml');

      expect(result).toContain('items = [ 1, 2, 3 ]');
    });
  });

  describe('Round-trip validation', () => {
    it('should validate JSON round-trip', () => {
      const content = '{"name": "test", "value": 42, "nested": {"key": "value"}}';
      const result = configParser.validateRoundTrip(content, 'json');

      expect(result).toBe(true);
    });

    it('should validate YAML round-trip', () => {
      const content = `
name: test
value: 42
nested:
  key: value
`;
      const result = configParser.validateRoundTrip(content, 'yaml');

      expect(result).toBe(true);
    });

    it('should validate TOML round-trip', () => {
      const content = `
name = "test"
value = 42

[nested]
key = "value"
`;
      const result = configParser.validateRoundTrip(content, 'toml');

      expect(result).toBe(true);
    });

    it('should return false for invalid JSON', () => {
      const content = '{invalid}';
      const result = configParser.validateRoundTrip(content, 'json');

      expect(result).toBe(false);
    });

    it('should return false for invalid YAML', () => {
      const content = 'invalid:\n  - bad\n  indentation';
      const result = configParser.validateRoundTrip(content, 'yaml');

      expect(result).toBe(false);
    });

    it('should return false for invalid TOML', () => {
      const content = '[invalid\nname = "test"';
      const result = configParser.validateRoundTrip(content, 'toml');

      expect(result).toBe(false);
    });

    it('should validate round-trip with arrays', () => {
      const content = '{"items": [1, 2, 3], "tags": ["a", "b", "c"]}';
      const result = configParser.validateRoundTrip(content, 'json');

      expect(result).toBe(true);
    });

    it('should validate round-trip with complex nested structures', () => {
      const content = JSON.stringify({
        server: {
          host: 'localhost',
          port: 3000,
          ssl: {
            enabled: true,
            cert: '/path/to/cert',
          },
        },
        database: {
          connections: [
            { name: 'primary', url: 'db1' },
            { name: 'replica', url: 'db2' },
          ],
        },
      });
      const result = configParser.validateRoundTrip(content, 'json');

      expect(result).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty objects', () => {
      const data = {};
      const jsonResult = configParser.format(data, 'json');
      const yamlResult = configParser.format(data, 'yaml');
      const tomlResult = configParser.format(data, 'toml');

      expect(jsonResult).toBe('{}');
      expect(yamlResult).toBe('{}\n');
      expect(tomlResult).toBe('');
    });

    it('should handle null values in JSON', () => {
      const data = { key: null };
      const result = configParser.format(data, 'json');

      expect(result).toContain('"key": null');
    });

    it('should handle boolean values', () => {
      const data = { enabled: true, disabled: false };
      const jsonResult = configParser.format(data, 'json');
      const yamlResult = configParser.format(data, 'yaml');
      const tomlResult = configParser.format(data, 'toml');

      expect(jsonResult).toContain('"enabled": true');
      expect(jsonResult).toContain('"disabled": false');
      expect(yamlResult).toContain('enabled: true');
      expect(yamlResult).toContain('disabled: false');
      expect(tomlResult).toContain('enabled = true');
      expect(tomlResult).toContain('disabled = false');
    });

    it('should handle numbers (integers and floats)', () => {
      const data = { integer: 42, float: 3.14, negative: -10 };
      const result = configParser.format(data, 'json');

      expect(result).toContain('"integer": 42');
      expect(result).toContain('"float": 3.14');
      expect(result).toContain('"negative": -10');
    });

    it('should handle special characters in strings', () => {
      const data = { text: 'Hello "World"\nNew line\tTab' };
      const result = configParser.format(data, 'json');

      expect(result).toContain('Hello \\"World\\"');
      expect(result).toContain('\\n');
      expect(result).toContain('\\t');
    });

    it('should throw error for unsupported format', () => {
      const data = { key: 'value' };

      expect(() => {
        configParser.format(data, 'xml' as ConfigFormat);
      }).toThrow('Unsupported format: xml');
    });
  });

  describe('Type safety', () => {
    it('should support generic type parameter for parse', () => {
      interface Config {
        name: string;
        value: number;
      }

      const content = '{"name": "test", "value": 42}';
      const result = configParser.parse<Config>(content, 'json');

      if (result.success) {
        expect(result.data?.name).toBe('test');
        expect(result.data?.value).toBe(42);
      }
    });

    it('should handle complex types', () => {
      interface ServerConfig {
        host: string;
        port: number;
        ssl: {
          enabled: boolean;
          cert: string;
        };
      }

      const content = JSON.stringify({
        host: 'localhost',
        port: 3000,
        ssl: {
          enabled: true,
          cert: '/path/to/cert',
        },
      });

      const result = configParser.parse<ServerConfig>(content, 'json');

      if (result.success) {
        expect(result.data?.host).toBe('localhost');
        expect(result.data?.port).toBe(3000);
        expect(result.data?.ssl.enabled).toBe(true);
        expect(result.data?.ssl.cert).toBe('/path/to/cert');
      }
    });
  });
});
