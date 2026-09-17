import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileToToolImage } from './index';

/**
 * The size and dimension gate on a captured frame.
 *
 * These are not cosmetic limits. A frame the provider refuses produces a 400,
 * and the frame is already in the message history when it does — so the same
 * 400 repeats on every later turn in that thread. Catching it here, before the
 * image is ever attached, is what keeps one bad screenshot from being permanent.
 *
 * The old check was on RAW bytes at 5MB, which is the wrong quantity: base64
 * inflates by 4/3, so a 4.9MB PNG passed and then arrived at the API as 6.5MB.
 */

/** A minimal but structurally real PNG header, so pngDimensions can read it. */
function pngWithHeader(width: number, height: number, payloadBytes = 0): Buffer {
  const head = Buffer.alloc(24);
  head.writeUInt32BE(0x89504e47, 0);
  head.writeUInt32BE(0x0d0a1a0a, 4);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(payloadBytes, 0x42)]);
}

function writeTemp(name: string, buf: Buffer): string {
  const p = path.join(os.tmpdir(), `bubbly_test_${Date.now()}_${name}`);
  fs.writeFileSync(p, buf);
  return p;
}

describe('fileToToolImage', () => {
  const written: string[] = [];
  const temp = (name: string, buf: Buffer) => {
    const p = writeTemp(name, buf);
    written.push(p);
    return p;
  };
  afterAll(() => {
    for (const p of written) { try { fs.unlinkSync(p); } catch { /* best effort */ } }
  });

  it('accepts an ordinary screenshot', () => {
    const out = fileToToolImage(temp('ok.png', pngWithHeader(1920, 1080, 4096)));
    expect('image' in out).toBe(true);
    if ('image' in out) {
      expect(out.image.mediaType).toBe('image/png');
      expect(out.image.data.length).toBeGreaterThan(0);
    }
  });

  it('tags a .jpg as image/jpeg', () => {
    const out = fileToToolImage(temp('ok.jpg', Buffer.alloc(2048, 0x11)));
    expect('image' in out).toBe(true);
    if ('image' in out) expect(out.image.mediaType).toBe('image/jpeg');
  });

  it('refuses a frame that would exceed the limit ONCE ENCODED', () => {
    // 3.6MB raw is under the old 5MB raw cap, and 4.8MB encoded — over the
    // encoded budget. This is exactly the case the old check let through.
    const out = fileToToolImage(temp('big.png', pngWithHeader(1920, 1080, 3_600_000)));
    expect('reason' in out).toBe(true);
    if ('reason' in out) expect(out.reason).toMatch(/encoded/i);
  });

  it('refuses a frame whose longest edge is over the pixel limit', () => {
    const out = fileToToolImage(temp('wide.png', pngWithHeader(11_520, 1080, 1024)));
    expect('reason' in out).toBe(true);
    if ('reason' in out) expect(out.reason).toMatch(/11520x1080/);
  });

  it('refuses an empty capture', () => {
    const out = fileToToolImage(temp('empty.png', Buffer.alloc(0)));
    expect('reason' in out).toBe(true);
  });

  it('gives a reason rather than throwing when the file is gone', () => {
    const out = fileToToolImage(path.join(os.tmpdir(), 'bubbly_test_does_not_exist.png'));
    expect('reason' in out).toBe(true);
    if ('reason' in out) expect(out.reason).toMatch(/read back from disk/i);
  });
});
