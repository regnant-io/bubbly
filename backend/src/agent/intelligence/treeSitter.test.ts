import { initTreeSitter, isTreeSitterReady, extractSymbolsWithTreeSitter } from './treeSitter';

/**
 * These cases are exactly the shapes the regex heuristics misread: generics with
 * angle brackets, decorators, and signatures split across lines. A real parse
 * tree has to get them right, because a WRONG symbol silently poisons the repo
 * map and task context.
 */
describe('tree-sitter symbol extraction', () => {
  beforeAll(async () => {
    await initTreeSitter();
  }, 60_000);

  it('initializes the wasm runtime and grammars', () => {
    expect(isTreeSitterReady()).toBe(true);
  });

  it('handles generics, decorators and multi-line signatures (TypeScript)', () => {
    const src = `
import { Injectable } from '@angular/core';
import type { Repo } from './repo';

@Injectable({ providedIn: 'root' })
export class UserService<T extends { id: string }> {
  private cache = new Map<string, T>();

  async findAll(
    filter: Partial<T>,
    options: { limit?: number; offset?: number } = {},
  ): Promise<T[]> {
    return [];
  }

  private helper(): void {}
}

export interface Options<K = string> { key: K }
export type Handler<A, B> = (a: A) => B;
export enum Mode { On, Off }
export function standalone<T>(x: T): T { return x; }
`;
    const out = extractSymbolsWithTreeSitter('src/user.ts', src, 'typescript');
    expect(out).not.toBeNull();
    const byName = new Map(out!.symbols.map((s) => [s.name, s]));

    // The generic class survives its `<T extends { id: string }>` header.
    expect(byName.get('UserService')).toMatchObject({ kind: 'class', exported: true });

    // A method whose signature spans four lines is still one method, attributed
    // to its class — the heuristics tend to lose or mis-attribute this.
    expect(byName.get('findAll')).toMatchObject({ kind: 'method', container: 'UserService' });
    expect(byName.get('helper')).toMatchObject({ kind: 'method', container: 'UserService' });

    expect(byName.get('Options')).toMatchObject({ kind: 'interface', exported: true });
    expect(byName.get('Handler')).toMatchObject({ kind: 'type', exported: true });
    expect(byName.get('Mode')).toMatchObject({ kind: 'enum', exported: true });
    expect(byName.get('standalone')).toMatchObject({ kind: 'function', exported: true });

    // Imports are edges, not text.
    expect(out!.imports.map((i) => i.specifier).sort()).toEqual(['./repo', '@angular/core']);
  });

  it('does not invent symbols from strings or comments', () => {
    const src = `
// export function ghostFromComment() {}
const sql = "CREATE FUNCTION ghostFromString() RETURNS void";
export function real() {}
`;
    const out = extractSymbolsWithTreeSitter('src/a.ts', src, 'typescript');
    const names = out!.symbols.map((s) => s.name);
    expect(names).toContain('real');
    expect(names).not.toContain('ghostFromComment');
    expect(names).not.toContain('ghostFromString');
  });

  it('attributes methods to their class and respects privacy (Python)', () => {
    const src = `
import os
from typing import List

class Widget:
    def render(self, depth: int = 0) -> str:
        return ""

    def _internal(self):
        pass

def top_level(a, b):
    return a + b
`;
    const out = extractSymbolsWithTreeSitter('src/w.py', src, 'python');
    const byName = new Map(out!.symbols.map((s) => [s.name, s]));
    expect(byName.get('Widget')).toMatchObject({ kind: 'class' });
    expect(byName.get('render')).toMatchObject({ kind: 'method', container: 'Widget', exported: true });
    // Leading underscore means private in Python.
    expect(byName.get('_internal')).toMatchObject({ kind: 'method', exported: false });
    expect(byName.get('top_level')).toMatchObject({ kind: 'function' });
    // `from typing import List` must record the edge to the MODULE (typing),
    // not the imported symbol (List) — otherwise the dependency graph points at
    // the wrong node.
    expect(out!.imports.map((i) => i.specifier)).toEqual(expect.arrayContaining(['os', 'typing']));
  });

  it('respects explicit private/protected members (TypeScript)', () => {
    const src = `
export class Svc {
  public open(): void {}
  private secret(): void {}
  protected guarded(): void {}
}
`;
    const out = extractSymbolsWithTreeSitter('svc.ts', src, 'typescript');
    const byName = new Map(out!.symbols.map((s) => [s.name, s]));
    // Being inside an exported class does not make a private member public API.
    expect(byName.get('open')).toMatchObject({ exported: true });
    expect(byName.get('secret')).toMatchObject({ exported: false });
    expect(byName.get('guarded')).toMatchObject({ exported: false });
  });

  it('falls back (returns null) for Ruby, whose grammar traps in this wasm build', () => {
    expect(extractSymbolsWithTreeSitter('a.rb', "class Foo\nend\n", 'ruby')).toBeNull();
  });

  it('uses capitalization for visibility (Go)', () => {
    const src = `
package main

import "fmt"

type Server struct { Addr string }

func (s *Server) Start() error { return nil }
func (s *Server) shutdown() {}
func Helper() {}
func private() {}
`;
    const out = extractSymbolsWithTreeSitter('main.go', src, 'go');
    const byName = new Map(out!.symbols.map((s) => [s.name, s]));
    expect(byName.get('Start')).toMatchObject({ exported: true });
    expect(byName.get('shutdown')).toMatchObject({ exported: false });
    expect(byName.get('Helper')).toMatchObject({ kind: 'function', exported: true });
    expect(byName.get('private')).toMatchObject({ exported: false });
  });

  it('reads pub visibility and item kinds (Rust)', () => {
    const src = `
use std::collections::HashMap;

pub struct Config { pub name: String }
pub trait Store { fn get(&self) -> String; }
enum Hidden { A, B }
pub fn build() -> Config { Config { name: String::new() } }
`;
    const out = extractSymbolsWithTreeSitter('lib.rs', src, 'rust');
    const byName = new Map(out!.symbols.map((s) => [s.name, s]));
    expect(byName.get('Config')).toMatchObject({ kind: 'struct', exported: true });
    expect(byName.get('Store')).toMatchObject({ kind: 'interface', exported: true });
    expect(byName.get('Hidden')).toMatchObject({ kind: 'enum', exported: false });
    expect(byName.get('build')).toMatchObject({ kind: 'function', exported: true });
  });

  it('returns null for a language with no grammar so the caller can fall back', () => {
    expect(extractSymbolsWithTreeSitter('a.txt', 'hello', 'other')).toBeNull();
  });
});
