// Nearest-match suggestion for mistyped credential names.
//
// Agents miss in two ways: a typo ('guthub' for 'github') or an
// over-specific guess ('posthog-api-key' when the stored key is 'posthog').
// Edit distance catches the first; substring containment catches the second.

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Return the closest candidate to `target`, or null when nothing is close
// enough to be worth suggesting.
function nearest(target, candidates) {
  const t = target.toLowerCase();
  let best = null;
  let bestScore = Infinity;
  for (const cand of candidates) {
    const c = cand.toLowerCase();
    if (cand === target) continue;
    const shorter = Math.min(t.length, c.length);
    const contained = shorter >= 3 && (t.includes(c) || c.includes(t));
    // Containment is a strong signal, so score it by the size of the extra
    // text (halved) to keep it ahead of comparable edit distances.
    const score = contained ? Math.abs(t.length - c.length) * 0.5 : levenshtein(t, c);
    if (score < bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  if (best === null) return null;
  const threshold = Math.max(2, Math.floor(target.length / 3));
  return bestScore <= threshold ? best : null;
}

module.exports = { nearest };
