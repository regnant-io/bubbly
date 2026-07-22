import { detectTruncatedWrite } from './writeIntegrity';

describe('detectTruncatedWrite', () => {
  describe('code (C-style)', () => {
    it('flags content cut off inside an unterminated string', () => {
      const code = 'const y = 2;\nconst z = "unclosed string at the end';
      expect(detectTruncatedWrite('a.ts', code).truncated).toBe(true);
    });

    it('flags the exact route.ts truncation pattern from the trace', () => {
      const code = [
        "import { NextRequest } from 'next/server';",
        'export async function POST(request: NextRequest) {',
        '  const bodyText = await request.text();',
        '  try {',
        '    if (typeof globalThis.TextDecoder !== "undefined") {',
        '      decodedBody = new TextDecoder().decode(body);',
        '    } else {',
        '',
      ].join('\n');
      expect(detectTruncatedWrite('api/todos/route.ts', code).truncated).toBe(true);
    });

    it('flags a file ending on a dangling token with no newline', () => {
      const code = 'function add(a, b) {\n  return a +';
      expect(detectTruncatedWrite('m.ts', code).truncated).toBe(true);
    });

    it('does NOT flag a complete, balanced file', () => {
      const code = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
      expect(detectTruncatedWrite('m.ts', code).truncated).toBe(false);
    });

    it('does NOT flag a complete Python file', () => {
      const code = 'def add(a, b):\n    return a + b\n';
      expect(detectTruncatedWrite('m.py', code).truncated).toBe(false);
    });

    it('does NOT flag a balanced file even without trailing newline', () => {
      const code = 'export const x = 1;\nexport const y = 2;';
      expect(detectTruncatedWrite('m.ts', code).truncated).toBe(false);
    });

    it('does NOT false-positive on braces inside strings', () => {
      const code = 'const tmpl = "function foo() { return 1; }";\nconst z = 2;\n';
      expect(detectTruncatedWrite('m.ts', code).truncated).toBe(false);
    });

    it('handles other C-family extensions (rust, go, java)', () => {
      expect(detectTruncatedWrite('main.rs', 'fn main() {\n    let x = (').truncated).toBe(true);
      expect(detectTruncatedWrite('main.go', 'package main\n\nfunc main() {}\n').truncated).toBe(false);
    });
  });

  describe('style (CSS / SCSS / LESS)', () => {
    it('flags a stylesheet cut off mid-rule', () => {
      const css = '.btn {\n  color: red;\n  background:';
      expect(detectTruncatedWrite('style.css', css).truncated).toBe(true);
    });

    it('flags an unclosed block', () => {
      const css = '.card {\n  padding: 1rem;\n  display: flex;\n';
      expect(detectTruncatedWrite('style.css', css).truncated).toBe(true);
    });

    it('does NOT treat # (ids / hex colors) as comments', () => {
      const css = '#header {\n  color: #ffffff;\n  background: #000;\n}\n';
      expect(detectTruncatedWrite('style.css', css).truncated).toBe(false);
    });

    it('does NOT flag a complete stylesheet', () => {
      const css = ':root {\n  --c: #fff;\n}\n.btn { color: var(--c); }\n';
      expect(detectTruncatedWrite('style.css', css).truncated).toBe(false);
    });

    it('supports // line comments in scss without false positives', () => {
      const scss = '// theme\n$primary: #3366ff;\n.btn {\n  color: $primary;\n}\n';
      expect(detectTruncatedWrite('theme.scss', scss).truncated).toBe(false);
    });
  });

  describe('markup (HTML / XML / SVG / Vue)', () => {
    it('flags an unclosed element', () => {
      const html = '<!DOCTYPE html>\n<html>\n<head><title>Hi</title></head>\n<body>\n  <div class="x">\n';
      expect(detectTruncatedWrite('index.html', html).truncated).toBe(true);
    });

    it('flags ending inside an unterminated tag', () => {
      const html = '<html><body><div class="container" data-x="';
      expect(detectTruncatedWrite('index.html', html).truncated).toBe(true);
    });

    it('flags an unterminated comment', () => {
      const html = '<html><body><!-- todo: finish this';
      expect(detectTruncatedWrite('index.html', html).truncated).toBe(true);
    });

    it('does NOT flag void elements as unclosed', () => {
      const html = '<html>\n<head>\n  <meta charset="utf-8">\n  <link rel="icon" href="x">\n</head>\n<body><img src="a"><br></body>\n</html>\n';
      expect(detectTruncatedWrite('index.html', html).truncated).toBe(false);
    });

    it('does NOT flag a complete document', () => {
      const html = '<!DOCTYPE html>\n<html>\n<head><title>Hi</title></head>\n<body><p>Hello</p></body>\n</html>\n';
      expect(detectTruncatedWrite('index.html', html).truncated).toBe(false);
    });

    it('handles self-closing svg/xml tags', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="4" /></svg>\n';
      expect(detectTruncatedWrite('icon.svg', svg).truncated).toBe(false);
    });
  });

  describe('json', () => {
    it('flags an object that is not closed', () => {
      const json = '{\n  "name": "app",\n  "version": "1.0.0",';
      expect(detectTruncatedWrite('package.json', json).truncated).toBe(true);
    });

    it('flags a string cut off mid-value', () => {
      const json = '{\n  "description": "a long descript';
      expect(detectTruncatedWrite('package.json', json).truncated).toBe(true);
    });

    it('does NOT flag complete JSON', () => {
      const json = '{\n  "name": "app",\n  "deps": ["a", "b"]\n}\n';
      expect(detectTruncatedWrite('package.json', json).truncated).toBe(false);
    });

    it('allows comments in jsonc', () => {
      const jsonc = '{\n  // config\n  "strict": true\n}\n';
      expect(detectTruncatedWrite('tsconfig.jsonc', jsonc).truncated).toBe(false);
    });
  });

  describe('config (YAML / TOML)', () => {
    it('flags an open flow collection', () => {
      const yaml = 'name: app\nlist: [a, b,';
      expect(detectTruncatedWrite('config.yaml', yaml).truncated).toBe(true);
    });

    it('does NOT flag normal block-style yaml', () => {
      const yaml = 'name: app\nsteps:\n  - build\n  - test\n';
      expect(detectTruncatedWrite('ci.yml', yaml).truncated).toBe(false);
    });

    it('does NOT treat # as a problem (yaml comments)', () => {
      const toml = '# config\n[server]\nport = 8080\n';
      expect(detectTruncatedWrite('config.toml', toml).truncated).toBe(false);
    });
  });

  describe('markdown', () => {
    it('flags an unclosed code fence', () => {
      const md = '# Title\n\n```ts\nconst x = 1;\n';
      expect(detectTruncatedWrite('README.md', md).truncated).toBe(true);
    });

    it('does NOT flag prose that ends mid-sentence', () => {
      const md = '# My Project\n\nThis is a readme that ends mid sentence and';
      expect(detectTruncatedWrite('README.md', md).truncated).toBe(false);
    });

    it('does NOT flag balanced code fences', () => {
      const md = '# Title\n\n```ts\nconst x = 1;\n```\n\nDone.\n';
      expect(detectTruncatedWrite('README.md', md).truncated).toBe(false);
    });
  });

  describe('general', () => {
    it('ignores empty content', () => {
      expect(detectTruncatedWrite('m.ts', '').truncated).toBe(false);
    });

    it('does NOT flag unknown / extension-less files', () => {
      expect(detectTruncatedWrite('LICENSE', 'Copyright (c) 2026 {{{').truncated).toBe(false);
      expect(detectTruncatedWrite('data.bin', 'whatever {[(').truncated).toBe(false);
    });
  });
});
