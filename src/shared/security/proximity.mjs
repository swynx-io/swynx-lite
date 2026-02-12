// src/security/proximity.mjs
// Path proximity detection for security-critical directories

const PROXIMITY_PATTERNS = [
  // Authentication
  { pattern: /[/\\]auth[/\\]/i, category: 'authentication', boost: 'CRITICAL' },
  { pattern: /[/\\]login[/\\]/i, category: 'authentication', boost: 'CRITICAL' },
  { pattern: /[/\\]oauth[/\\]/i, category: 'authentication', boost: 'CRITICAL' },
  { pattern: /[/\\]sso[/\\]/i, category: 'authentication', boost: 'CRITICAL' },

  // Cryptography
  { pattern: /[/\\]crypto[/\\]/i, category: 'cryptography', boost: 'CRITICAL' },
  { pattern: /[/\\]encryption[/\\]/i, category: 'cryptography', boost: 'CRITICAL' },

  // Sandbox / isolation
  { pattern: /[/\\]sandbox[/\\]/i, category: 'sandbox', boost: 'CRITICAL' },
  { pattern: /[/\\]task-runner[/\\]/i, category: 'sandbox', boost: 'CRITICAL' },

  // Webhooks
  { pattern: /[/\\]webhook[s]?[/\\]/i, category: 'webhooks', boost: 'HIGH' },

  // API
  { pattern: /[/\\]api[/\\]/i, category: 'api', boost: 'MEDIUM' },
  { pattern: /[/\\]graphql[/\\]/i, category: 'api', boost: 'MEDIUM' },

  // Admin
  { pattern: /[/\\]admin[/\\]/i, category: 'admin', boost: 'HIGH' },

  // Payment / billing
  { pattern: /[/\\]payment[s]?[/\\]/i, category: 'payment', boost: 'CRITICAL' },
  { pattern: /[/\\]billing[/\\]/i, category: 'payment', boost: 'HIGH' },
  { pattern: /[/\\]checkout[/\\]/i, category: 'payment', boost: 'HIGH' },

  // Middleware
  { pattern: /[/\\]middleware[/\\]/i, category: 'middleware', boost: 'MEDIUM' },

  // Access control
  { pattern: /[/\\]rbac[/\\]/i, category: 'access-control', boost: 'CRITICAL' },
  { pattern: /[/\\]acl[/\\]/i, category: 'access-control', boost: 'HIGH' },
  { pattern: /[/\\]permissions?[/\\]/i, category: 'access-control', boost: 'HIGH' },

  // Tokens / JWT
  { pattern: /[/\\]jwt[/\\]/i, category: 'tokens', boost: 'CRITICAL' },
  { pattern: /[/\\]tokens?[/\\]/i, category: 'tokens', boost: 'HIGH' },

  // File upload
  { pattern: /[/\\]upload[s]?[/\\]/i, category: 'file-upload', boost: 'HIGH' },

  // Secrets
  { pattern: /[/\\]secrets?[/\\]/i, category: 'secrets', boost: 'CRITICAL' }
];

const BOOST_RANK = { CRITICAL: 3, HIGH: 2, MEDIUM: 1 };

/**
 * Check if a file path is in a security-critical directory.
 * Returns { isCritical, matches: [{category, boost}], highestBoost }
 */
export function checkProximity(filePath) {
  const matches = [];

  for (const { pattern, category, boost } of PROXIMITY_PATTERNS) {
    if (pattern.test(filePath)) {
      matches.push({ category, boost });
    }
  }

  if (matches.length === 0) {
    return { isCritical: false, matches: [], highestBoost: null };
  }

  let highestBoost = matches[0].boost;
  for (let i = 1; i < matches.length; i++) {
    if (BOOST_RANK[matches[i].boost] > BOOST_RANK[highestBoost]) {
      highestBoost = matches[i].boost;
    }
  }

  return {
    isCritical: highestBoost === 'CRITICAL',
    matches,
    highestBoost
  };
}
