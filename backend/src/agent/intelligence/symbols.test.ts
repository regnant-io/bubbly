import { extractSymbols, detectLanguage } from './symbols';

describe('symbol extraction', () => {
  it('detects languages from extensions', () => {
    expect(detectLanguage('a/b/c.ts')).toBe('typescript');
    expect(detectLanguage('x.py')).toBe('python');
    expect(detectLanguage('main.go')).toBe('go');
    expect(detectLanguage('lib.rs')).toBe('rust');
    expect(detectLanguage('readme.md')).toBe('other');
  });

  it('extracts TypeScript functions, classes, methods, and imports', () => {
    const src = `
import { foo } from './foo';
import React from 'react';

export interface User { id: string; }
export type Id = string;

export function login(email: string) { return email; }

export const logout = async () => { return true; };

export class AuthService {
  private token: string = '';
  async authenticate(creds: string) { return creds; }
  get current() { return this.token; }
}
`;
    const result = extractSymbols('src/auth.ts', src);
    expect(result.language).toBe('typescript');

    const names = result.symbols.map((s) => s.name);
    expect(names).toContain('User');
    expect(names).toContain('Id');
    expect(names).toContain('login');
    expect(names).toContain('logout');
    expect(names).toContain('AuthService');
    expect(names).toContain('authenticate');

    const authMethod = result.symbols.find((s) => s.name === 'authenticate');
    expect(authMethod?.kind).toBe('method');
    expect(authMethod?.container).toBe('AuthService');

    const iface = result.symbols.find((s) => s.name === 'User');
    expect(iface?.kind).toBe('interface');
    expect(iface?.exported).toBe(true);

    const specs = result.imports.map((i) => i.specifier);
    expect(specs).toContain('./foo');
    expect(specs).toContain('react');
  });

  it('extracts Python classes, functions, and methods with correct containers', () => {
    const src = `
from app.models import User
import os

class UserService:
    def __init__(self):
        self.users = []

    def create_user(self, name):
        return name

def standalone():
    return 1
`;
    const result = extractSymbols('app/service.py', src);
    expect(result.language).toBe('python');

    const cls = result.symbols.find((s) => s.name === 'UserService');
    expect(cls?.kind).toBe('class');

    const method = result.symbols.find((s) => s.name === 'create_user');
    expect(method?.kind).toBe('method');
    expect(method?.container).toBe('UserService');

    const fn = result.symbols.find((s) => s.name === 'standalone');
    expect(fn?.kind).toBe('function');
    expect(fn?.container).toBeUndefined();

    expect(result.imports.map((i) => i.specifier)).toContain('app.models');
  });

  it('extracts Go functions and structs with export visibility', () => {
    const src = `
package main

import (
    "fmt"
    "net/http"
)

type Server struct {
    addr string
}

func NewServer() *Server { return &Server{} }

func internalHelper() {}
`;
    const result = extractSymbols('main.go', src);
    expect(result.language).toBe('go');

    const struct = result.symbols.find((s) => s.name === 'Server');
    expect(struct?.kind).toBe('struct');
    expect(struct?.exported).toBe(true);

    const exported = result.symbols.find((s) => s.name === 'NewServer');
    expect(exported?.exported).toBe(true);

    const internal = result.symbols.find((s) => s.name === 'internalHelper');
    expect(internal?.exported).toBe(false);

    expect(result.imports.map((i) => i.specifier)).toEqual(
      expect.arrayContaining(['fmt', 'net/http'])
    );
  });

  it('produces compact single-line signatures', () => {
    const src = `export function complicated(a: number, b: string): Promise<void> {\n  return Promise.resolve();\n}`;
    const result = extractSymbols('x.ts', src);
    const fn = result.symbols.find((s) => s.name === 'complicated');
    expect(fn).toBeDefined();
    expect(fn!.signature).not.toContain('\n');
    expect(fn!.signature).toContain('complicated');
  });
});
