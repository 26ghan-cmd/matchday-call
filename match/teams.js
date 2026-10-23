'use strict';
// Recognising the same club under different names ("Man Utd", "Manchester United",
// "Wolverhampton Wanderers"…) so data from different providers can be matched up.

const ALIASES = {
  ARS: ['arsenal'],
  AVL: ['aston villa', 'villa'],
  BOU: ['bournemouth', 'afc bournemouth'],
  BRE: ['brentford'],
  BHA: ['brighton', 'brighton and hove albion', 'brighton hove albion'],
  BUR: ['burnley'],
  CHE: ['chelsea'],
  COV: ['coventry', 'coventry city'],
  CRY: ['crystal palace', 'palace'],
  EVE: ['everton'],
  FUL: ['fulham'],
  HUL: ['hull', 'hull city'],
  IPS: ['ipswich', 'ipswich town'],
  LEE: ['leeds', 'leeds united'],
  LEI: ['leicester', 'leicester city'],
  LIV: ['liverpool'],
  LUT: ['luton', 'luton town'],
  MCI: ['manchester city', 'man city'],
  MID: ['middlesbrough', 'boro'],
  MIL: ['millwall'],
  MUN: ['manchester united', 'man united', 'man utd', 'manchester utd'],
  NEW: ['newcastle', 'newcastle united'],
  NFO: ['nottingham forest', 'nottm forest', 'forest'],
  NOR: ['norwich', 'norwich city'],
  SHU: ['sheffield united', 'sheffield utd'],
  SOU: ['southampton'],
  STK: ['stoke', 'stoke city'],
  SUN: ['sunderland'],
  TOT: ['tottenham', 'tottenham hotspur', 'spurs'],
  WAT: ['watford'],
  WBA: ['west brom', 'west bromwich albion'],
  WHU: ['west ham', 'west ham united'],
  WOL: ['wolves', 'wolverhampton', 'wolverhampton wanderers'],
};

const normalize = (s = '') => String(s)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/['’.]/g, '')
  .replace(/\b(fc|afc|the)\b/g, ' ')
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Longest aliases first, so "manchester city" wins over shorter matches.
const ALIAS_LIST = Object.entries(ALIASES)
  .flatMap(([code, names]) => names.map((n) => [normalize(n), code]))
  .sort((a, b) => b[0].length - a[0].length);

// The club code for a name, or null. Exact match first, then a whole-word match inside it.
function teamCode(name) {
  const n = normalize(name);
  if (!n) return null;
  const exact = ALIAS_LIST.find(([alias]) => alias === n);
  if (exact) return exact[1];
  const inside = ALIAS_LIST.find(([alias]) => new RegExp(`\\b${alias}\\b`).test(n));
  return inside ? inside[1] : null;
}

// Every club mentioned in a piece of text (e.g. "Arsenal vs Everton Winner?").
function teamsIn(text) {
  let n = ` ${normalize(text)} `;
  const found = [];
  ALIAS_LIST.forEach(([alias, code]) => {
    const re = new RegExp(` ${alias} `);
    if (re.test(n)) {
      found.push(code);
      n = n.replace(re, ' ');
    }
  });
  return [...new Set(found)];
}

module.exports = { teamCode, teamsIn, normalize };
