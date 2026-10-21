'use strict';
// The match hub: keeps one live data feed per match that at least one room is
// watching, and hands every update to the server to send out. Data for a match
// is fetched once and shared by every room, so API usage doesn't grow with users.

const { EventEmitter } = require('events');
const { ApiFootball, LIVE_STATUSES, FINISHED_STATUSES } = require('./api-football');
const { DemoMatch } = require('./demo');
const { Feed, templateAnalysis } = require('./feed');
const { claudeAnalysis, aiEnabled } = require('./ai');

const env = process.env;
const LIVE_POLL_MS = Math.max(10, Number(env.LIVE_POLL_SECONDS) || 15) * 1000;
const ODDS_POLL_MS = Math.max(15, Number(env.ODDS_POLL_SECONDS) || 30) * 1000;
const FIXTURE_LIST_MS = 10 * 60 * 1000;
const DEMO_SECONDS_PER_MINUTE = Math.max(1, Number(env.DEMO_SECONDS_PER_MINUTE) || 4);

class MatchHub extends EventEmitter {
  constructor({ log = console } = {}) {
    super();
    this.log = log;
    this.api = new ApiFootball({ key: env.API_FOOTBALL_KEY, season: env.PL_SEASON, log });
    this.matches = new Map();   // fixtureId -> match state
    this.fixtureCache = { at: 0, list: null, error: null };
    this.demoCount = 0;
  }

  get provider() { return this.api.configured ? 'api-football' : 'none'; }

  // ---------------- Fixture list ----------------
  async listFixtures() {
    const result = { configured: this.api.configured, ai: aiEnabled(), fixtures: [], error: null };
    if (!this.api.configured) return result;
    const fresh = Date.now() - this.fixtureCache.at < FIXTURE_LIST_MS;
    if (!fresh) {
      try {
        this.fixtureCache = { at: Date.now(), list: await this.api.fixtures(), error: null };
      } catch (err) {
        this.log.error('Fixture list failed:', err.message);
        // Keep showing the last good list; retry in a minute.
        this.fixtureCache = { at: Date.now() - FIXTURE_LIST_MS + 60e3, list: this.fixtureCache.list, error: err.message };
      }
    }
    result.fixtures = this.fixtureCache.list || [];
    result.error = this.fixtureCache.error;
    return result;
  }

  isKnownFixture(id) {
    return this.matches.has(id) || (this.fixtureCache.list || []).some((f) => f.id === id);
  }

  // ---------------- Watching ----------------
  // Start following a match for a room. Returns the fixture id actually used
  // ('demo' becomes a fresh demo match for that room).
  watch(requestedId, room) {
    let id = String(requestedId);
    if (id === 'demo') id = `demo-${++this.demoCount}`;
    let m = this.matches.get(id);
    if (!m) {
      m = { id, watchers: new Set(), fixture: null, odds: null, feed: new Feed(), timers: [], stopped: false,
        analysing: false, pendingReason: null, version: 0 };
      this.matches.set(id, m);
      if (id.startsWith('demo-')) this.startDemo(m);
      else this.startLive(m);
    }
    m.watchers.add(room);
    return id;
  }

  unwatch(id, room) {
    const m = this.matches.get(id);
    if (!m) return;
    m.watchers.delete(room);
    if (!m.watchers.size) {
      m.stopped = true;
      m.timers.forEach(clearTimeout);
      m.demo?.stop();
      this.matches.delete(id);
    }
  }

  watchersOf(id) { return this.matches.get(id)?.watchers || new Set(); }

  payload(id) {
    const m = this.matches.get(id);
    if (!m || !m.fixture) return null;
    return { fixtureId: id, fixture: m.fixture, odds: m.odds, feed: m.feed.lines, version: m.version, ai: aiEnabled() };
  }

  publish(m) {
    m.version++;
    this.emit('update', m.id, this.payload(m.id));
  }

  // ---------------- Demo ----------------
  startDemo(m) {
    m.demo = new DemoMatch({
      id: m.id,
      secondsPerMinute: DEMO_SECONDS_PER_MINUTE,
      onUpdate: (fixture, odds) => {
        if (m.stopped) return;
        this.applyFixture(m, fixture);
        m.odds = odds;
        this.publish(m);
      },
    });
    m.demo.start();
  }

  // ---------------- Live (API-Football) ----------------
  startLive(m) {
    const loopFixture = async () => {
      if (m.stopped) return;
      let delay = LIVE_POLL_MS;
      try {
        const fixture = await this.api.fixture(m.id);
        this.applyFixture(m, fixture);
        this.publish(m);
        delay = this.fixtureDelay(fixture);
      } catch (err) {
        this.log.error(`Match ${m.id}:`, err.message);
        delay = 60e3;
      }
      if (delay != null && !m.stopped) m.timers.push(setTimeout(loopFixture, delay));
    };

    const loopOdds = async () => {
      if (m.stopped) return;
      let delay = ODDS_POLL_MS;
      try {
        const st = m.fixture?.status.short;
        if (!m.fixture) delay = 5e3; // wait for the fixture first
        else if (FINISHED_STATUSES.has(st)) { m.odds = null; this.publish(m); return; }
        else if (LIVE_STATUSES.has(st)) {
          m.odds = (await this.api.liveOdds(m.id, m.fixture)) || m.odds;
          this.publish(m);
        } else {
          m.odds = (await this.api.preMatchOdds(m.id, m.fixture)) || m.odds;
          this.publish(m);
          delay = 15 * 60e3;
        }
      } catch (err) {
        this.log.error(`Odds ${m.id}:`, err.message);
        delay = 2 * 60e3;
      }
      if (this.api.remaining != null && this.api.remaining < 20) delay = Math.max(delay, 10 * 60e3);
      if (!m.stopped) m.timers.push(setTimeout(loopOdds, delay));
    };

    loopFixture();
    loopOdds();
  }

  fixtureDelay(fixture) {
    const st = fixture.status.short;
    let delay;
    if (FINISHED_STATUSES.has(st)) return null; // final result is in; stop polling
    if (LIVE_STATUSES.has(st)) delay = st === 'HT' ? 30e3 : LIVE_POLL_MS;
    else {
      const untilKickoff = new Date(fixture.kickoff).getTime() - Date.now();
      delay = untilKickoff < 15 * 60e3 ? 60e3 : 5 * 60e3;
    }
    // Running low on today's API allowance: slow right down rather than run out.
    if (this.api.remaining != null && this.api.remaining < 20) {
      if (!this.warnedLow) this.log.warn(`API-Football: only ${this.api.remaining} requests left today; slowing updates.`);
      this.warnedLow = true;
      delay = Math.max(delay, 5 * 60e3);
    }
    return delay;
  }

  // ---------------- Feed + analysis ----------------
  applyFixture(m, fixture) {
    m.fixture = fixture;
    const triggers = m.feed.update(fixture);
    if (triggers.length) this.analyse(m, triggers);
  }

  async analyse(m, triggers) {
    const important = ['fulltime', 'halftime', 'goal', 'red', 'var', 'miss'];
    const reason = important.find((r) => triggers.includes(r)) || 'interval';
    // One analysis at a time; if something else happens meanwhile, cover it next.
    if (m.analysing) {
      if (!m.pendingReason || important.indexOf(reason) !== -1) m.pendingReason = reason;
      return;
    }
    m.analysing = true;
    const snap = m.fixture;
    let text = null;
    let by = 'stats';
    try {
      text = await claudeAnalysis(snap, reason, m.feed.lines.slice(-15));
      if (text) by = 'ai';
    } catch (err) {
      this.log.error('AI analysis failed, using stats-based analysis:', err.message);
    }
    if (!text) {
      const result = templateAnalysis(snap, reason, m.lastTags || []);
      text = result.text;
      m.lastTags = result.tags;
    }
    m.analysing = false;
    if (m.stopped) return;
    if (m.pendingReason) {
      const next = m.pendingReason;
      m.pendingReason = null;
      setTimeout(() => this.analyse(m, [next]), 0);
    }
    if (!text) return;
    const minute = snap.status.short === 'HT' ? 'HT'
      : snap.status.short === 'FT' ? 'FT'
      : snap.status.elapsed != null ? `${snap.status.elapsed}${snap.status.extra ? `+${snap.status.extra}` : ''}'` : '';
    m.feed.add({ kind: 'analysis', minute, text, by });
    this.publish(m);
  }
}

module.exports = { MatchHub };
