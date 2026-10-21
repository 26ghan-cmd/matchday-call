'use strict';
// TV sync: working out how far behind each person's TV is.
//
// Everyone's broadcast is the same pictures at a different delay. When someone
// taps the moment their TV's match clock hits a known time (kick-off = 0:00,
// second-half kick-off = 45:00, or any minute changing over), we know the
// moment *their* TV showed the clock at zero for that half:
//
//     zero = tapTime − clockTime
//
// Compare two people's zeros and you have the gap between their TVs. The real
// time between the two halves is the same for everybody, so if anyone has synced
// in both halves we can also compare a first-half sync with a second-half one.

const HALF_SECONDS = 45 * 60;
const MAX_LAG = 150; // seconds; bigger gaps are almost certainly a mis-tap

// Turn a tap into "when did this person's TV show 0:00 (or 45:00) for this half".
function zeroFromTap({ half, clockSec, tapAt }) {
  const halfStart = half === 2 ? HALF_SECONDS : 0;
  return tapAt - (clockSec - halfStart) * 1000;
}

function validTap({ half, clockSec, tapAt }, now = Date.now()) {
  if (half !== 1 && half !== 2) return false;
  if (!Number.isFinite(clockSec) || !Number.isFinite(tapAt)) return false;
  const min = half === 1 ? 0 : HALF_SECONDS;
  const max = half === 1 ? 60 * 60 : 105 * 60; // allow for stoppage time
  if (clockSec < min || clockSec > max) return false;
  // Not in the future, and from this match (taps are re-sent after a reconnect).
  return tapAt - now < 60 * 1000 && now - tapAt < 4 * 3600 * 1000;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// cals: Map(id -> { h1?: zeroMs, h2?: zeroMs, at: lastTapMs })
// Returns { lags: { id: secondsBehindTheMostAheadTV | null }, gap: halfGapMs | null,
//           flagged: [ids whose sync doesn't fit with everyone else's] }
function computeLags(cals) {
  const entries = [...cals.entries()];
  const both = entries.filter(([, c]) => c.h1 != null && c.h2 != null).map(([, c]) => c.h2 - c.h1);
  const gap = both.length ? median(both) : null;

  // Put everyone on the same half's timeline, preferring the one most people synced in.
  const onHalf = (half) => entries.map(([id, c]) => {
    if (half === 1) return [id, c.h1 ?? (gap != null && c.h2 != null ? c.h2 - gap : null)];
    return [id, c.h2 ?? (gap != null && c.h1 != null ? c.h1 + gap : null)];
  });
  const count = (list) => list.filter(([, z]) => z != null).length;
  const h1 = onHalf(1), h2 = onHalf(2);
  const chosen = count(h2) >= count(h1) ? h2 : h1;

  // A sync more than MAX_LAG away from everyone else's is almost certainly a
  // mis-tap (usually the wrong minute). Leave out the most recent offender and
  // ask them to check, rather than holding anyone back by minutes.
  let known = chosen.filter(([, z]) => z != null);
  const flagged = [];
  const spread = (list) => Math.max(...list.map(([, z]) => z)) - Math.min(...list.map(([, z]) => z));
  while (known.length > 1 && spread(known) > MAX_LAG * 1000) {
    const latest = known.reduce((a, b) => ((cals.get(b[0]).at || 0) > (cals.get(a[0]).at || 0) ? b : a));
    flagged.push(latest[0]);
    known = known.filter(([id]) => id !== latest[0]);
  }

  const lags = {};
  entries.forEach(([id]) => { lags[id] = null; });
  if (known.length) {
    const earliest = Math.min(...known.map(([, z]) => z));
    known.forEach(([id, z]) => {
      lags[id] = Math.round(((z - earliest) / 1000) * 10) / 10;
    });
  }
  return { lags, gap, flagged };
}

module.exports = { zeroFromTap, validTap, computeLags, HALF_SECONDS, MAX_LAG };
