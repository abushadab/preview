const crypto = require('crypto');

class URLGenerator {
  constructor() {
    this.sequentialId = 0;
  }

  // Option 1: Sequential Base36 IDs
  generateSequential() {
    const id = this.sequentialId++;
    return id.toString(36).padStart(4, '0').slice(-4); // Always 4 chars
  }

  // Option 2: Random Hex (current implementation)
  generateRandom(length = 8) {
    return crypto.randomBytes(length / 2).toString('hex').slice(0, length);
  }

  // Option 3: Pronounceable Words
  generatePronounceable() {
    const adjectives = [
      'clever', 'quick', 'swift', 'bright', 'smart', 'fast', 'cool', 'nice',
      'happy', 'silly', 'funny', 'sweet', 'gentle', 'kind', 'bold', 'brave'
    ];

    const nouns = [
      'tiger', 'fox', 'cat', 'dog', 'bird', 'fish', 'lion', 'bear',
      'tree', 'river', 'mountain', 'ocean', 'cloud', 'star', 'moon', 'sun'
    ];

    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const number = Math.floor(Math.random() * 1000);

    return `${adjective}-${noun}-${number}`;
  }

  // Option 4: Time-Based + Random
  generateTimeBased() {
    const now = new Date();
    const timestamp = now.toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 12); // YYYYMMDDHHMM
    const random = crypto.randomBytes(2).toString('hex');
    return `${timestamp}-${random}`;
  }

  // Option 5: Hash-Based (for deterministic URLs)
  generateHashBased(input) {
    const hash = crypto.createHash('sha256')
      .update(input)
      .digest('hex')
      .slice(0, 8);
    return hash;
  }

  // Option 6: UUID v4 (Standard)
  generateUUID() {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  }

  // Option 7: Memorable Names + Numbers
  generateMemorable() {
    const names = [
      'alpha', 'beta', 'gamma', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
      'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa'
    ];

    const name = names[Math.floor(Math.random() * names.length)];
    const number = Math.floor(Math.random() * 90000) + 10000; // 5-digit number

    return `${name}-${number}`;
  }

  // Main generator method based on configuration
  generate(method = 'random', options = {}) {
    switch (method) {
      case 'sequential':
        return this.generateSequential();
      case 'pronounceable':
        return this.generatePronounceable();
      case 'time':
        return this.generateTimeBased();
      case 'hash':
        return this.generateHashBased(options.input || '');
      case 'uuid':
        return this.generateUUID();
      case 'memorable':
        return this.generateMemorable();
      case 'random':
      default:
        return this.generateRandom(options.length || 8);
    }
  }

  // Validate that an ID is available (not in use)
  async validate(id, checkExisting = true) {
    if (!checkExisting) return true;

    // Check if sandbox with this ID already exists
    // Implementation depends on your storage mechanism
    try {
      // This would typically check Redis or your database
      // For now, return true (you'll implement actual checking)
      return true;
    } catch (error) {
      return false;
    }
  }

  // Generate with collision avoidance
  async generateSafe(method = 'random', maxAttempts = 10) {
    let attempts = 0;

    while (attempts < maxAttempts) {
      const id = this.generate(method);
      const valid = await this.validate(id);

      if (valid) {
        return id;
      }

      attempts++;
    }

    // Fallback to random with longer ID
    return this.generateRandom(12);
  }
}

module.exports = URLGenerator;