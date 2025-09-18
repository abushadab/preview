const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveEnv, redactUrl } = require('../env');

describe('resolveEnv', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('returns direct env value', () => {
    process.env.MY_KEY = 'value';
    expect(resolveEnv('MY_KEY')).toBe('value');
  });

  test('reads value from *_FILE path', () => {
    const tmpFile = path.join(os.tmpdir(), `resolve-env-${Date.now()}`);
    fs.writeFileSync(tmpFile, 'file-value');
    process.env.MY_KEY_FILE = tmpFile;
    expect(resolveEnv('MY_KEY')).toBe('file-value');
    fs.unlinkSync(tmpFile);
  });

  test('throws when required file is empty', () => {
    const tmpFile = path.join(os.tmpdir(), `resolve-env-empty-${Date.now()}`);
    fs.writeFileSync(tmpFile, '');
    process.env.MY_KEY_FILE = tmpFile;
    expect(() => resolveEnv('MY_KEY', { required: true })).toThrow('points to an empty file');
    fs.unlinkSync(tmpFile);
  });

  test('returns fallback when unset', () => {
    delete process.env.MY_KEY;
    expect(resolveEnv('MY_KEY', { fallback: 'fallback' })).toBe('fallback');
  });

  test('trims whitespace by default', () => {
    process.env.MY_KEY = ' spaced ';
    expect(resolveEnv('MY_KEY')).toBe('spaced');
  });
});

describe('redactUrl', () => {
  test('masks credentials in URL', () => {
    const redacted = redactUrl('https://user:supersecret@example.com/path');
    expect(redacted).toBe('https://****:****@example.com/path');
    expect(redacted).not.toContain('supersecret');
  });
});
