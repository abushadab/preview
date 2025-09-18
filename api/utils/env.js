const fs = require('fs');

function resolveEnv(key, { required = false, fallback, trim = true } = {}) {
  const fileKey = `${key}_FILE`;

  if (process.env[fileKey]) {
    try {
      const fileValue = fs.readFileSync(process.env[fileKey], 'utf8');
      const normalized = trim ? fileValue.trim() : fileValue;

      if (!normalized && required && fallback === undefined) {
        throw new Error(`Environment variable ${fileKey} points to an empty file`);
      }

      return normalized || fallback;
    } catch (error) {
      throw new Error(`Unable to read ${fileKey}: ${error.message}`);
    }
  }

  const value = process.env[key];

  if ((value === undefined || value === '') && required && fallback === undefined) {
    throw new Error(`Missing required environment variable ${key}`);
  }

  if (value === undefined || value === '') {
    return fallback;
  }

  return trim ? value.trim() : value;
}

function redactUrl(url) {
  if (!url) return url;

  try {
    const parsed = new URL(url);

    if (parsed.username) parsed.username = '****';
    if (parsed.password) parsed.password = '****';

    return parsed.toString();
  } catch (_) {
    return '****';
  }
}

module.exports = { resolveEnv, redactUrl };
