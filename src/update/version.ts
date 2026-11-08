export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  build?: string;
}

export function parseVersion(v: string): ParsedVersion | null {
  if (!v || typeof v !== 'string') return null;
  const trimmed = v.trim().replace(/^v/, '');
  const [coreAndPre, build] = trimmed.split('+');
  const [core, prerelease] = coreAndPre.split('-');
  const parts = core.split('.').map((p) => {
    const n = parseInt(p, 10);
    return isNaN(n) ? 0 : n;
  });
  return {
    major: parts[0] ?? 0,
    minor: parts[1] ?? 0,
    patch: parts[2] ?? 0,
    prerelease,
    build,
  };
}

/**
 * Compares two versions semantically: semver core (major, minor, patch, prerelease)
 * and build metadata as a timestamp.
 * Returns > 0 if a > b, < 0 if a < b, 0 if a == b.
 */
export function compareVersions(aStr: string, bStr: string): number {
  if (aStr === bStr) return 0;
  const a = parseVersion(aStr);
  const b = parseVersion(bStr);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;

  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && b.prerelease && a.prerelease !== b.prerelease) {
    return a.prerelease.localeCompare(b.prerelease);
  }

  if (!a.build && !b.build) return 0;
  if (a.build && !b.build) return 1;
  if (!a.build && b.build) return -1;

  const b1 = a.build!;
  const b2 = b.build!;
  if (b1 === b2) return 0;

  // Normalise 12-digit timestamps (YYYYMMDDHHmm) to 14-digit (YYYYMMDDHHmmss)
  const norm1 = /^\d{12}$/.test(b1) ? `${b1}00` : b1;
  const norm2 = /^\d{12}$/.test(b2) ? `${b2}00` : b2;

  if (/^\d+$/.test(norm1) && /^\d+$/.test(norm2)) {
    if (norm1.length === norm2.length) {
      return norm1 > norm2 ? 1 : -1;
    }
    try {
      const diff = BigInt(norm1) - BigInt(norm2);
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    } catch {
      // Fallback to string comparison
    }
  }

  return norm1.localeCompare(norm2);
}

/**
 * Returns true if candidate is strictly newer than current.
 * Downgrades and equal versions return false.
 */
export function isNewerVersion(candidate: string, current: string | null | undefined): boolean {
  if (!candidate) return false;
  if (!current) return true;
  return compareVersions(candidate, current) > 0;
}
