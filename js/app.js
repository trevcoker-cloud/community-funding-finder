/* Community Funding Finder — search, filters, deadline status, tracker and exports
   for CICs, registered charities and non-profit organisations. */

(function () {
  'use strict';

  const TRACKER_KEY = 'cicff.tracker.v1';
  const PROFILE_KEY = 'cicff.profile.v1';
  const DAY = 86400000;

  const state = {
    query: '',
    statuses: new Set(),
    categories: new Set(),
    scope: '',
    sizes: new Set(),
    types: new Set(),
    efforts: new Set(),
    deadline: '',
    orgType: '',
    confirmedOnly: false,
    hideAuto: false,
    sort: 'deadline',
    view: 'search',
  };

  const SIZES = [
    { id: 'small', label: 'Up to £5k', min: 0, max: 5000 },
    { id: 'mid', label: '£5k–£20k', min: 5000, max: 20000 },
    { id: 'large', label: '£20k–£100k', min: 20000, max: 100000 },
    { id: 'major', label: '£100k+', min: 100000, max: Infinity },
  ];

  const ORG_TYPES = [
    { id: 'cic', chip: 'CIC', full: 'Community Interest Company', plural: 'CICs' },
    { id: 'charity', chip: 'Charity', full: 'registered charity', plural: 'charities' },
    { id: 'nonprofit', chip: 'Non-profit', full: 'non-profit organisation', plural: 'non-profits' },
  ];

  const ORG_STATUS_LABEL = { yes: 'Eligible', check: 'Check eligibility', no: 'Not eligible' };

  function orgStatus(fund, type) {
    return (fund.orgTypes && fund.orgTypes[type]) || 'check';
  }

  function orgTypeMeta(type) {
    return ORG_TYPES.find((t) => t.id === type);
  }

  const STATUS_GROUPS = [
    { id: 'open', label: 'Open now', match: ['open', 'rolling'] },
    { id: 'closing', label: 'Closing soon', match: ['closing-soon'] },
    { id: 'opening', label: 'Opening soon', match: ['opening-soon'] },
    { id: 'closed', label: 'Closed / paused', match: ['closed', 'announced'] },
  ];

  const STATUS_META = {
    open: { label: 'Open now', cls: 'open' },
    'closing-soon': { label: 'Closing soon', cls: 'closing' },
    rolling: { label: 'Rolling deadline', cls: 'rolling' },
    'opening-soon': { label: 'Opening soon', cls: 'opening' },
    closed: { label: 'Closed', cls: 'closed' },
    announced: { label: 'Not open', cls: 'announced' },
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  /* ---------- Dates and status ---------- */
  function parseYMD(str) {
    const [y, m, d] = String(str).split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function closeMoment(fund) {
    if (!fund.closes) return null;
    const d = parseYMD(fund.closes);
    if (fund.closesTime) {
      const [h, m] = fund.closesTime.split(':').map(Number);
      d.setHours(h, m, 0, 0);
    } else {
      d.setHours(23, 59, 59, 999);
    }
    return d;
  }

  function openMoment(fund) {
    return fund.opens ? parseYMD(fund.opens) : null;
  }

  function statusOf(fund, at = new Date()) {
    if (fund.deadlineType === 'announced') return 'announced';
    const close = closeMoment(fund);
    if (fund.deadlineType === 'closed' && !close) return 'closed';
    if (close && at > close) return 'closed';
    if (fund.deadlineType === 'rolling' || !close) {
      const open = openMoment(fund);
      if (open && at < open) return 'opening-soon';
      return 'rolling';
    }
    const open = openMoment(fund);
    if (open && at < open) return 'opening-soon';
    const days = Math.ceil((close - at) / DAY);
    return days <= 30 ? 'closing-soon' : 'open';
  }

  function daysUntil(fund, at = new Date()) {
    const close = closeMoment(fund);
    if (!close) return null;
    return Math.ceil((close - at) / DAY);
  }

  function fmtDate(date, opts = {}) {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', ...opts,
    }).format(date);
  }

  function fmtMoment(fund) {
    if (!fund.closes) return '';
    const d = parseYMD(fund.closes);
    let out = fmtDate(d);
    if (fund.closesTime) out += `, ${fund.closesTime}`;
    return out;
  }

  function money(n) {
    if (!n) return '—';
    if (n >= 1000000) {
      const m = n / 1000000;
      return '£' + (Number.isInteger(m) ? m : m.toFixed(1)) + 'm';
    }
    return '£' + n.toLocaleString('en-GB');
  }

  function awardRange(fund) {
    if (!fund.awardMax) return 'Award not published';
    if (fund.awardMin === fund.awardMax) return money(fund.awardMax);
    if (!fund.awardMin) return `Up to ${money(fund.awardMax)}`;
    return `${money(fund.awardMin)}–${money(fund.awardMax)}`;
  }

  function deadlineInfo(fund) {
    const status = statusOf(fund);
    if (status === 'closed') {
      return { value: fund.closes ? 'Closed ' + fmtDate(parseYMD(fund.closes)) : 'Closed', label: fund.closes ? 'Applications closed' : 'No current round' };
    }
    if (status === 'announced') return { value: 'Not yet open', label: 'No application route' };
    if (status === 'opening-soon') {
      return { value: 'Opens ' + fmtDate(parseYMD(fund.opens)), label: 'Not open yet' };
    }
    if (status === 'rolling') return { value: 'Rolling deadline', label: 'No closing date' };
    const days = daysUntil(fund);
    const label = days <= 0 ? 'Closes today' : days === 1 ? 'Closes tomorrow' : `${days} days left`;
    return { value: 'Closes ' + fmtMoment(fund), label };
  }

  /* ---------- Storage ---------- */
  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      toast('Could not save locally — browser storage may be full.');
    }
  }

  function getTracker() { return readJSON(TRACKER_KEY, {}); }
  function saveTracker(t) { writeJSON(TRACKER_KEY, t); }
  function isSaved(id) { return Boolean(getTracker()[id]); }

  function toggleSave(id) {
    const tracker = getTracker();
    if (tracker[id]) {
      delete tracker[id];
      toast('Removed from your tracker');
    } else {
      tracker[id] = { status: 'considering', notes: '', savedAt: new Date().toISOString() };
      toast('Saved to your tracker');
    }
    saveTracker(tracker);
    updateTrackerBadge();
    render();
    if (!$('#drawer').hidden) openDrawer(id);
  }

  function updateTrackerBadge() {
    const count = Object.keys(getTracker()).length;
    const badge = $('#trackerCount');
    badge.hidden = count === 0;
    badge.textContent = String(count);
  }

  /* ---------- Filtering ---------- */
  function searchHaystack(fund) {
    return [
      fund.name, fund.funder, fund.summary, fund.description, fund.scope,
      fund.scopeDetail, fund.fundingType, ...(fund.categories || []),
      ...(fund.priorities || []), ...(fund.eligibility || []),
      fund.awardNote || '', ...ORG_TYPES.map((t) => t.full),
    ].join(' ').toLowerCase();
  }

  function sizeMatches(fund, bucket) {
    const max = fund.awardMax || 0;
    const min = fund.awardMin || 0;
    return max >= bucket.min && min <= bucket.max;
  }

  function matches(fund) {
    if (state.hideAuto && fund.origin === 'auto') return false;
    if (state.orgType) {
      if (orgStatus(fund, state.orgType) === 'no') return false;
      if (state.confirmedOnly && orgStatus(fund, state.orgType) !== 'yes') return false;
    } else if (state.confirmedOnly && !ORG_TYPES.some((t) => orgStatus(fund, t.id) === 'yes')) {
      return false;
    }
    if (state.scope && fund.scope !== state.scope) return false;

    if (state.categories.size) {
      const hit = fund.categories.some((c) => state.categories.has(c));
      if (!hit) return false;
    }

    if (state.types.size && !state.types.has(fund.fundingType)) return false;
    if (state.efforts.size && !state.efforts.has(fund.effort)) return false;

    if (state.sizes.size) {
      const hit = SIZES.some((s) => state.sizes.has(s.id) && sizeMatches(fund, s));
      if (!hit) return false;
    }

    if (state.statuses.size) {
      const status = statusOf(fund);
      const hit = STATUS_GROUPS.some(
        (g) => state.statuses.has(g.id) && g.match.includes(status)
      );
      if (!hit) return false;
    }

    if (state.deadline) {
      const days = daysUntil(fund);
      const windowDays = Number(state.deadline);
      if (days === null || days < 0 || days > windowDays) return false;
    }

    if (state.query.trim()) {
      const haystack = searchHaystack(fund);
      const tokens = state.query.toLowerCase().split(/\s+/).filter(Boolean);
      if (!tokens.every((t) => haystack.includes(t))) return false;
    }

    return true;
  }

  function sortFunds(list) {
    const rank = { 'closing-soon': 0, open: 1, rolling: 2, 'opening-soon': 3, announced: 4, closed: 5 };
    const copy = list.slice();
    if (state.sort === 'az') {
      copy.sort((a, b) => a.name.localeCompare(b.name));
    } else if (state.sort === 'value') {
      copy.sort((a, b) => (b.awardMax || 0) - (a.awardMax || 0));
    } else {
      copy.sort((a, b) => {
        const ra = rank[statusOf(a)];
        const rb = rank[statusOf(b)];
        if (ra !== rb) return ra - rb;
        const ca = closeMoment(a);
        const cb = closeMoment(b);
        if (ca && cb) return ca - cb;
        if (ca) return -1;
        if (cb) return 1;
        return a.name.localeCompare(b.name);
      });
    }
    return copy;
  }

  function getFiltered() {
    return sortFunds(FUNDS.filter(matches));
  }

  /* ---------- Render: filters ---------- */
  function chipHTML(label, pressed, value, type) {
    return `<button type="button" class="chip" data-filter="${type}" data-value="${esc(value)}" aria-pressed="${pressed}">${esc(label)}</button>`;
  }

  function renderFilterChips() {
    const orgEl = $('#orgFilters');
    orgEl.innerHTML = ORG_TYPES
      .map((t) => chipHTML(t.chip, state.orgType === t.id, t.id, 'org'))
      .join('');

    const statusEl = $('#statusFilters');
    statusEl.innerHTML = STATUS_GROUPS
      .map((g) => chipHTML(g.label, state.statuses.has(g.id), g.id, 'status'))
      .join('');

    const catEl = $('#categoryFilters');
    catEl.innerHTML = CATEGORIES
      .map((c) => chipHTML(c, state.categories.has(c), c, 'category'))
      .join('');

    const sizeEl = $('#sizeFilters');
    sizeEl.innerHTML = SIZES
      .map((s) => chipHTML(s.label, state.sizes.has(s.id), s.id, 'size'))
      .join('');

    const typeEl = $('#typeFilters');
    typeEl.innerHTML = FUNDING_TYPES
      .map((t) => chipHTML(t, state.types.has(t), t, 'type'))
      .join('');

    const effortEl = $('#effortFilters');
    effortEl.innerHTML = EFFORTS
      .map((e) => chipHTML(e, state.efforts.has(e), e, 'effort'))
      .join('');

    const scopeEl = $('#scopeFilter');
    scopeEl.innerHTML = '<option value="">Anywhere in the UK</option>' +
      SCOPES.map((s) => `<option value="${esc(s)}"${state.scope === s ? ' selected' : ''}>${esc(s)}</option>`).join('');

    $('#confirmedOnly').checked = state.confirmedOnly;
    $('#sortSelect').value = state.sort;
    $('#deadlineFilter').value = state.deadline;
  }

  function renderActiveFilters() {
    const el = $('#activeFilters');
    const items = [];

    if (state.orgType) {
      const meta = orgTypeMeta(state.orgType);
      if (meta) items.push({ label: meta.chip, type: 'org', value: state.orgType });
    }
    if (state.confirmedOnly) items.push({ label: 'Confirmed eligibility', type: 'confirmed', value: '1' });
    if (state.hideAuto) items.push({ label: 'Hiding auto-found', type: 'auto', value: '1' });
    state.categories.forEach((c) => items.push({ label: c, type: 'category', value: c }));
    state.statuses.forEach((s) => {
      const g = STATUS_GROUPS.find((x) => x.id === s);
      if (g) items.push({ label: g.label, type: 'status', value: s });
    });
    state.sizes.forEach((s) => {
      const size = SIZES.find((x) => x.id === s);
      if (size) items.push({ label: size.label, type: 'size', value: s });
    });
    state.types.forEach((t) => items.push({ label: t, type: 'type', value: t }));
    state.efforts.forEach((e) => items.push({ label: `${e} applications`, type: 'effort', value: e }));
    if (state.scope) items.push({ label: state.scope, type: 'scope', value: state.scope });
    if (state.query) items.push({ label: `“${state.query}”`, type: 'query', value: state.query });
    if (state.deadline) {
      const labels = { 30: 'Closing in 30 days', 90: 'Closing in 3 months', 180: 'Closing in 6 months' };
      items.push({ label: labels[state.deadline] || 'Deadline window', type: 'deadline', value: state.deadline });
    }

    if (!items.length) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }

    el.hidden = false;
    el.innerHTML = items.map((i) =>
      `<span class="active-filter">${esc(i.label)}<button type="button" data-remove="${i.type}" data-value="${esc(i.value)}" aria-label="Remove filter ${esc(i.label)}">&times;</button></span>`
    ).join('');
  }

  function clearFilter(type, value) {
    if (type === 'query') {
      state.query = '';
      $('#searchInput').value = '';
      $('#clearSearch').hidden = true;
    } else if (type === 'scope') {
      state.scope = '';
    } else if (type === 'deadline') {
      state.deadline = '';
    } else if (type === 'org') {
      state.orgType = '';
    } else if (type === 'confirmed') {
      state.confirmedOnly = false;
    } else if (type === 'auto') {
      state.hideAuto = false;
      $('#hideAuto').checked = false;
    } else if (type === 'category') {
      state.categories.delete(value);
    } else if (type === 'status') {
      state.statuses.delete(value);
    } else if (type === 'size') {
      state.sizes.delete(value);
    } else if (type === 'type') {
      state.types.delete(value);
    } else if (type === 'effort') {
      state.efforts.delete(value);
    }
    renderFilterChips();
    render();
  }

  /* ---------- Render: cards ---------- */
  function orgPillHTML(fund) {
    const tooltip = ORG_TYPES
      .map((t) => `${t.chip}: ${ORG_STATUS_LABEL[orgStatus(fund, t.id)].toLowerCase()}`)
      .join(' · ');

    if (state.orgType) {
      const meta = orgTypeMeta(state.orgType);
      const value = orgStatus(fund, state.orgType);
      const cls = value === 'yes' ? 'pill--cic' : value === 'check' ? 'pill--check' : 'pill--no';
      return `<span class="pill ${cls}" title="${esc(tooltip)}">${esc(meta.chip)}: ${esc(ORG_STATUS_LABEL[value].toLowerCase())}</span>`;
    }

    const eligible = ORG_TYPES.filter((t) => orgStatus(fund, t.id) === 'yes');
    const excluded = ORG_TYPES.filter((t) => orgStatus(fund, t.id) === 'no');
    const label = eligible.length === ORG_TYPES.length
      ? 'CIC, charity & non-profit'
      : eligible.length === 1
        ? (excluded.length === ORG_TYPES.length - 1 ? `${eligible[0].chip} only` : `${eligible[0].chip} eligible`)
        : eligible.length
          ? eligible.map((t) => t.chip).join(' & ')
          : 'Eligibility to check';
    const cls = eligible.length ? 'pill--cic' : 'pill--check';
    return `<span class="pill ${cls}" title="${esc(tooltip)}">${esc(label)}</span>`;
  }

  function cardHTML(fund) {
    const status = statusOf(fund);
    const meta = STATUS_META[status];
    const dl = deadlineInfo(fund);
    const orgPill = orgPillHTML(fund);

    return `
      <article class="card" data-id="${esc(fund.id)}">
        <div class="card__top">
          <span class="card__funder">${esc(fund.funder)}</span>
          <button class="save-btn${isSaved(fund.id) ? ' is-saved' : ''}" data-save="${esc(fund.id)}"
            aria-pressed="${isSaved(fund.id)}" aria-label="${isSaved(fund.id) ? 'Remove' : 'Save'} ${esc(fund.name)}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v16l-6-4.2L6 20V4z" fill="${isSaved(fund.id) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <h3 class="card__title"><button type="button" data-open="${esc(fund.id)}">${esc(fund.name)}</button></h3>
        <p class="card__summary">${esc(fund.summary)}</p>
        <div class="card__pills">
          <span class="status status--${meta.cls}">${meta.label}</span>
          <span class="pill pill--award">${esc(awardRange(fund))}</span>
          <span class="pill">${esc(fund.scope)}</span>
          ${orgPill}
          ${fund.origin === 'auto' ? '<span class="pill pill--auto" title="Found automatically by reading the funder\'s own page — confirm the round and criteria before applying">Auto-found</span>' : ''}
        </div>
        <div class="card__foot">
          <div class="deadline">
            <span class="deadline__value">${esc(dl.value)}</span>
            <span class="deadline__label">${esc(dl.label)}</span>
          </div>
          <div class="card__actions">
            <button type="button" class="text-btn" data-open="${esc(fund.id)}">Details</button>
            <button type="button" class="text-btn" data-draft="${esc(fund.id)}">Draft</button>
          </div>
        </div>
      </article>`;
  }

  function render() {
    const filtered = getFiltered();
    const grid = $('#resultsGrid');
    grid.innerHTML = filtered.map(cardHTML).join('');
    $('#emptyState').hidden = filtered.length > 0;

    const closing = FUNDS.filter((f) => statusOf(f) === 'closing-soon').length;
    const openCount = FUNDS.filter((f) => ['open', 'rolling'].includes(statusOf(f))).length;
    const parts = [`${filtered.length} ${filtered.length === 1 ? 'fund' : 'funds'}`];
    if (filtered.length) {
      const near = filtered.filter((f) => {
        const d = daysUntil(f);
        return d !== null && d >= 0 && d <= 30;
      }).length;
      if (near) parts.push(`${near} closing within 30 days`);
    }
    $('#resultsMeta').textContent = state.view === 'search' ? parts.join(' · ') : '';

    const applyBtn = $('#applyFilters');
    if (applyBtn) applyBtn.textContent = `Show ${filtered.length} ${filtered.length === 1 ? 'fund' : 'funds'}`;

    $('#statOpen').textContent = String(openCount);
    $('#statClosing').textContent = String(closing);
    $('#statTotal').textContent = String(FUNDS.length);

    renderActiveFilters();
    renderTimeline();
    renderTracker();
    renderHeroPanel();
  }

  function renderHeroPanel() {
    const items = FUNDS
      .filter((f) => f.closes && closeMoment(f) > new Date())
      .sort((a, b) => closeMoment(a) - closeMoment(b))
      .slice(0, 3);

    $('#heroDeadlineCount').textContent = items.length ? `${items.length} coming up` : '';
    $('#heroDeadlines').innerHTML = items.map((f) => {
      const d = closeMoment(f);
      const days = daysUntil(f);
      const when = days <= 0 ? 'closes today' : days === 1 ? 'tomorrow' : `${days} days left`;
      const mon = new Intl.DateTimeFormat('en-GB', { month: 'short' }).format(d);
      return `<li class="hero__deadline">
        <button type="button" data-open="${esc(f.id)}">
          <span class="hero__deadline-date"><span class="hero__deadline-day">${d.getDate()}</span><span class="hero__deadline-mon">${esc(mon)}</span></span>
          <span class="hero__deadline-body">
            <span class="hero__deadline-name">${esc(f.name)}</span>
            <span class="hero__deadline-meta">${esc(awardRange(f))} · ${esc(when)}</span>
          </span>
        </button>
      </li>`;
    }).join('');
  }

  /* ---------- Render: timeline ---------- */
  function timelineRow(fund) {
    const close = closeMoment(fund);
    const status = statusOf(fund);
    const meta = STATUS_META[status];
    const day = close ? String(close.getDate()) : '—';
    const monthYear = close
      ? fmtDate(close, { day: undefined, month: 'short', year: 'numeric' })
      : (['closed', 'announced'].includes(status) ? 'Closed' : 'Rolling');
    return `
      <div class="timeline-row">
        <div class="timeline-row__date">
          <span class="timeline-row__day">${esc(day)}</span>
          <span class="timeline-row__year">${esc(monthYear)}</span>
        </div>
        <div class="timeline-row__main">
          <button class="timeline-row__title" type="button" data-open="${esc(fund.id)}">${esc(fund.name)}</button>
          <div class="timeline-row__funder">${esc(fund.funder)}</div>
        </div>
        <div class="timeline-row__side">
          <span class="timeline-row__award">${esc(awardRange(fund))}</span>
          <span class="status status--${meta.cls}">${meta.label}</span>
        </div>
      </div>`;
  }

  function renderTimeline() {
    const dated = FUNDS
      .filter((f) => f.closes && closeMoment(f) > new Date())
      .sort((a, b) => closeMoment(a) - closeMoment(b));

    const groups = new Map();
    dated.forEach((f) => {
      const key = fmtDate(closeMoment(f), { day: undefined, month: 'long', year: 'numeric' });
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    });

    let html = '';
    groups.forEach((funds, month) => {
      html += `<h3 class="timeline__month">${esc(month)}</h3>`;
      html += funds.map(timelineRow).join('');
    });

    const rolling = FUNDS
      .filter((f) => statusOf(f) === 'rolling')
      .sort((a, b) => a.name.localeCompare(b.name));

    if (rolling.length) {
      html += '<h3 class="timeline__month">Rolling — no closing date</h3>';
      html += rolling.map(timelineRow).join('');
    }

    const dormant = FUNDS
      .filter((f) => ['closed', 'announced'].includes(statusOf(f)))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (dormant.length) {
      html += '<h3 class="timeline__month">Closed, paused or not yet open</h3>';
      html += dormant.map(timelineRow).join('');
    }

    html += `<p class="source-note">Opening dates are shown where a funder publishes them. Rolling programmes can pause at short notice; check the funder page before planning delivery.</p>`;
    $('#timeline').innerHTML = html;
  }

  /* ---------- Render: tracker ---------- */
  const TRACKER_STATUSES = ['considering', 'drafting', 'submitted', 'awarded', 'unsuccessful'];

  function renderTracker() {
    const tracker = getTracker();
    const entries = Object.entries(tracker)
      .map(([id, data]) => ({ fund: FUNDS.find((f) => f.id === id), data }))
      .filter((e) => e.fund);

    const list = $('#trackerList');
    if (!entries.length) {
      list.innerHTML = `
        <div class="tracker-empty">
          <h3>Nothing saved yet</h3>
          <p>Use the bookmark icon on any fund to save it here. You can track your application stage and keep private notes — all stored in this browser.</p>
          <button class="btn btn--primary" type="button" data-goto-search>Browse open funds</button>
        </div>`;
      return;
    }

    list.innerHTML = entries.map(({ fund, data }) => {
      const dl = deadlineInfo(fund);
      const status = statusOf(fund);
      const meta = STATUS_META[status];
      return `
        <div class="tracker-item" data-id="${esc(fund.id)}">
          <div class="tracker-item__top">
            <div>
              <h3 class="tracker-item__title">${esc(fund.name)}</h3>
              <p class="tracker-item__funder">${esc(fund.funder)} · ${esc(awardRange(fund))}</p>
            </div>
            <span class="status status--${meta.cls}">${meta.label}</span>
          </div>
          <div class="tracker-item__row">
            <label class="field">
              <span class="field__label">Stage</span>
              <select data-stage="${esc(fund.id)}">
                ${TRACKER_STATUSES.map((s) => `<option value="${s}"${data.status === s ? ' selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
              </select>
            </label>
            <label class="field">
              <span class="field__label">Closes</span>
              <input type="text" value="${esc(dl.value)}" readonly>
            </label>
            <label class="field tracker-item__notes">
              <span class="field__label">Notes</span>
              <input type="text" data-notes="${esc(fund.id)}" value="${esc(data.notes || '')}" placeholder="Contact, documents needed, next step…">
            </label>
          </div>
          <div class="tracker-item__links">
            <button class="text-btn" type="button" data-open="${esc(fund.id)}">View details</button>
            <button class="text-btn" type="button" data-draft="${esc(fund.id)}">Draft application</button>
            <button class="text-btn" type="button" data-remove-saved="${esc(fund.id)}">Remove</button>
          </div>
        </div>`;
    }).join('');
  }

  /* ---------- Export ---------- */
  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csvCell(value) {
    const s = String(value == null ? '' : value);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCSV() {
    const rows = getFiltered();
    if (!rows.length) {
      toast('No funds to export with these filters.');
      return;
    }
    const header = ['Fund', 'Funder', 'Funding type', 'Status', 'Opens', 'Closes', 'Award min (£)', 'Award max (£)', 'Scope', 'CIC eligibility', 'Charity eligibility', 'Non-profit eligibility', 'Application effort', 'Deadline note', 'Apply URL', 'Source'];
    const body = rows.map((f) => [
      f.name, f.funder, f.fundingType, STATUS_META[statusOf(f)].label,
      f.opens || '', f.closes || '', f.awardMin || '', f.awardMax || '',
      f.scope, orgStatus(f, 'cic'), orgStatus(f, 'charity'), orgStatus(f, 'nonprofit'),
      f.effort, f.dateNote, f.applyUrl, f.sourceUrl,
    ]);
    const csv = [header, ...body].map((r) => r.map(csvCell).join(',')).join('\r\n');
    download('community-funding-results.csv', csv, 'text/csv;charset=utf-8');
    toast(`Exported ${rows.length} funds`);
  }

  function icsEscape(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  }

  function icsStamp(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}00`;
  }

  function buildICS(funds) {
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Community Funding Finder//EN',
      'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Community grant deadlines',
    ];
    let count = 0;
    funds.forEach((fund) => {
      if (!fund.closes) return;
      const close = closeMoment(fund);
      const start = new Date(close);
      start.setHours(9, 0, 0, 0);
      const end = new Date(start.getTime() + 30 * 60000);
      lines.push(
        'BEGIN:VEVENT',
        `UID:${fund.id}@community-funding-finder`,
        `DTSTAMP:${icsStamp(new Date())}Z`,
        `DTSTART:${icsStamp(start)}`,
        `DTEND:${icsStamp(end)}`,
        `SUMMARY:${icsEscape('Deadline: ' + fund.name)}`,
        `DESCRIPTION:${icsEscape(`${fund.funder}. ${awardRange(fund)}. ${fund.dateNote} Apply: ${fund.applyUrl}`)}`,
        `URL:${icsEscape(fund.applyUrl)}`,
        'BEGIN:VALARM', 'TRIGGER:-P7D', 'ACTION:DISPLAY',
        `DESCRIPTION:${icsEscape('One week left: ' + fund.name)}`, 'END:VALARM',
        'END:VEVENT'
      );
      count += 1;
    });
    lines.push('END:VCALENDAR');
    return { ics: lines.join('\r\n'), count };
  }

  function downloadCalendar() {
    const tracker = getTracker();
    const saved = Object.keys(tracker).map((id) => FUNDS.find((f) => f.id === id)).filter(Boolean);
    const funds = saved.length ? saved : getFiltered();
    const { ics, count } = buildICS(funds);
    if (!count) {
      toast('No fixed deadlines in this selection to add to a calendar.');
      return;
    }
    download('community-grant-deadlines.ics', ics, 'text/calendar;charset=utf-8');
    toast(`Calendar file created with ${count} deadlines`);
  }

  /* ---------- Drawer ---------- */
  function openDrawer(id) {
    const fund = FUNDS.find((f) => f.id === id);
    if (!fund) return;
    const status = statusOf(fund);
    const meta = STATUS_META[status];
    const saved = isSaved(fund.id);
    const orgRows = ORG_TYPES.map((t) => {
      const value = orgStatus(fund, t.id);
      const name = t.full.charAt(0).toUpperCase() + t.full.slice(1);
      return `<li><span>${esc(name)}</span><span class="elig-tag elig-tag--${value}">${esc(ORG_STATUS_LABEL[value])}</span></li>`;
    }).join('');

    const openLabel = fund.opens
      ? fmtDate(parseYMD(fund.opens))
      : ['closed', 'announced'].includes(status) ? '—' : fund.deadlineType === 'rolling' ? 'Now' : 'Not published';
    const closeLabel = fund.closes ? fmtMoment(fund) : (fund.deadlineType === 'rolling' ? 'No closing date' : '—');

    $('#drawerFunder').textContent = fund.funder;
    $('#drawerBody').innerHTML = `
      <h2 id="drawerTitle">${esc(fund.name)}</h2>
      <div class="drawer__status-row">
        <span class="status status--${meta.cls}">${meta.label}</span>
        <span class="pill pill--award">${esc(awardRange(fund))}</span>
        <span class="pill">${esc(fund.scope)}</span>
      </div>
      <p class="drawer__summary">${esc(fund.summary)}</p>

      <div class="elig-panel">
        <div class="elig-panel__title">Who this fund is for</div>
        <ul class="elig-list">${orgRows}</ul>
      </div>

      <div class="date-panel">
        <div class="date-panel__cell">
          <div class="date-panel__label">Opens</div>
          <div class="date-panel__value">${esc(openLabel)}</div>
          <div class="date-panel__note">${fund.deadlineType === 'rolling' ? 'Applications accepted continuously' : 'Check funder page'}</div>
        </div>
        <div class="date-panel__cell">
          <div class="date-panel__label">Closes</div>
          <div class="date-panel__value">${esc(closeLabel)}</div>
          <div class="date-panel__note">${esc(status === 'closing-soon' ? deadlineInfo(fund).label : '')}</div>
        </div>
        <div class="date-panel__cell date-panel__full">
          <div class="date-panel__label">Deadline detail</div>
          <div class="date-panel__value">${esc(fund.dateNote)}</div>
          <div class="date-panel__note">Decision: ${esc(fund.decisionTime || 'Not published')}</div>
        </div>
      </div>

      <div class="drawer__actions">
        <button class="btn btn--primary" type="button" data-draft="${esc(fund.id)}">Draft answer <span aria-hidden="true">✦</span></button>
        <a class="btn btn--secondary" href="${esc(fund.applyUrl)}" target="_blank" rel="noopener">Funder page ↗</a>
        <button class="btn btn--secondary" type="button" data-save="${esc(fund.id)}">${saved ? 'Saved ✓' : 'Save to tracker'}</button>
      </div>

      <div class="drawer-section">
        <h3>About this fund</h3>
        <p>${esc(fund.description)}</p>
      </div>

      <div class="drawer-section">
        <h3>What it funds</h3>
        <ul class="tick-list">${fund.priorities.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      </div>

      <div class="drawer-section">
        <h3>Eligibility detail</h3>
        <ul class="tick-list">${fund.eligibility.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      </div>

      <div class="drawer-section">
        <h3>How to apply</h3>
        <ol class="step-list">${fund.applicationSteps.map((p) => `<li>${esc(p)}</li>`).join('')}</ol>
      </div>

      <div class="drawer-section">
        <h3>Tips for a stronger application</h3>
        <ul>${fund.tips.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      </div>

      <div class="drawer-section">
        <h3>Award and effort</h3>
        <p>${esc(fund.awardNote)}. Application effort: <strong>${esc(fund.effort)}</strong>. Funding type: ${esc(fund.fundingType)}.</p>
      </div>

      <p class="source-note">
        Checked ${esc(fmtDate(parseYMD(fund.verified)))}${fund.confidence === 'check' ? ' — some details need confirming with the funder' : ''}.
        ${fund.origin === 'auto' ? `<strong>Found automatically</strong> on ${esc(fmtDate(parseYMD(fund.discovered || fund.verified)))} by reading the funder's page — no one has checked this entry by hand yet. ` : ''}
        ${fund.charityNo ? `Registered charity ${esc(fund.charityNo)} (Charity Commission register). ` : ''}Source: <a href="${esc(fund.sourceUrl)}" target="_blank" rel="noopener">${esc(fund.funder)}</a>.
        Deadlines and criteria can change without notice; always confirm before applying.
      </p>`;

    const overlay = $('#drawerOverlay');
    overlay.hidden = false;
    $('#drawer').hidden = false;
    document.body.classList.add('no-scroll');
    $('#closeDrawer').focus({ preventScroll: true });
  }

  function closeDrawer() {
    $('#drawer').hidden = true;
    if (isNothingOpen()) {
      $('#drawerOverlay').hidden = true;
      document.body.classList.remove('no-scroll');
    }
  }

  function isNothingOpen() {
    return $('#drawer').hidden && $('#studio').hidden && $('#methodModal').hidden
      && $('#sourceModal').hidden && !$('#filtersPanel').classList.contains('is-open');
  }

  /* ---------- Studio ---------- */
  function openStudio(grantId) {
    const select = $('#studioGrant');
    if (grantId && FUNDS.some((f) => f.id === grantId)) select.value = grantId;
    $('#studio').hidden = false;
    $('#drawer').hidden = true;
    $('#drawerOverlay').hidden = false;
    document.body.classList.add('no-scroll');
    $('#closeStudio').focus({ preventScroll: true });
    document.dispatchEvent(new CustomEvent('studio:open', { detail: { fundId: select.value } }));
  }

  function closeStudio() {
    $('#studio').hidden = true;
    if (isNothingOpen()) {
      $('#drawerOverlay').hidden = true;
      document.body.classList.remove('no-scroll');
    }
  }

  function closeAllPanels() {
    $('#drawer').hidden = true;
    $('#studio').hidden = true;
    $('#methodModal').hidden = true;
    $('#sourceModal').hidden = true;
    $('#sourceOverlay').hidden = true;
    $('#drawerOverlay').hidden = true;
    $('#filtersPanel').classList.remove('is-open');
    $('#mobileFilters').setAttribute('aria-expanded', 'false');
    document.body.classList.remove('no-scroll');
    $('#filtersPanel').style.display = '';
  }

  /* ---------- Toast ---------- */
  let toastTimer;
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  /* ---------- Events ---------- */
  function bindEvents() {
    $('#searchInput').addEventListener('input', (e) => {
      state.query = e.target.value;
      $('#clearSearch').hidden = !state.query;
      render();
    });

    $('#clearSearch').addEventListener('click', () => {
      state.query = '';
      $('#searchInput').value = '';
      $('#clearSearch').hidden = true;
      $('#searchInput').focus();
      render();
    });

    $('#filtersPanel').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-filter]');
      if (!chip) return;
      const { filter, value } = chip.dataset;
      if (filter === 'org') {
        if (state.orgType === value) {
          state.orgType = '';
          state.confirmedOnly = false;
        } else {
          state.orgType = value;
        }
        renderFilterChips();
        render();
        return;
      }
      const sets = { status: state.statuses, category: state.categories, size: state.sizes, type: state.types, effort: state.efforts };
      const set = sets[filter];
      if (!set) return;
      set.has(value) ? set.delete(value) : set.add(value);
      renderFilterChips();
      render();
    });

    $('#activeFilters').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove]');
      if (!btn) return;
      clearFilter(btn.dataset.remove, btn.dataset.value);
    });

    $('#scopeFilter').addEventListener('change', (e) => {
      state.scope = e.target.value;
      render();
    });

    $('#deadlineFilter').addEventListener('change', (e) => {
      state.deadline = e.target.value;
      render();
    });

    $('#confirmedOnly').addEventListener('change', (e) => {
      state.confirmedOnly = e.target.checked;
      render();
    });

    $('#hideAuto').addEventListener('change', (e) => {
      state.hideAuto = e.target.checked;
      render();
    });

    $('#findFunds').addEventListener('click', () => startDailyUpdate());

    $('#sortSelect').addEventListener('change', (e) => {
      state.sort = e.target.value;
      render();
    });

    $('#resetFilters').addEventListener('click', resetFilters);
    $('#emptyReset').addEventListener('click', resetFilters);

    $('#exportCsv').addEventListener('click', exportCSV);
    $('#downloadCalendar').addEventListener('click', downloadCalendar);

    $('#resultsGrid').addEventListener('click', handleCardAction);
    $('#timeline').addEventListener('click', handleCardAction);
    $('#drawerBody').addEventListener('click', handleCardAction);
    $('#trackerList').addEventListener('click', (e) => {
      const remove = e.target.closest('[data-remove-saved]');
      if (remove) {
        toggleSave(remove.dataset.removeSaved);
        return;
      }
      if (e.target.closest('[data-goto-search]')) {
        setView('search');
        return;
      }
      handleCardAction(e);
    });

    $('#trackerList').addEventListener('change', (e) => {
      const stage = e.target.closest('[data-stage]');
      if (!stage) return;
      const tracker = getTracker();
      if (tracker[stage.dataset.stage]) {
        tracker[stage.dataset.stage].status = stage.value;
        saveTracker(tracker);
        toast('Application stage updated');
      }
    });

    $('#trackerList').addEventListener('input', (e) => {
      const notes = e.target.closest('[data-notes]');
      if (!notes) return;
      const tracker = getTracker();
      if (tracker[notes.dataset.notes]) {
        tracker[notes.dataset.notes].notes = notes.value;
        saveTracker(tracker);
      }
    });

    $('.hero__panel').addEventListener('click', (e) => {
      if (e.target.closest('[data-goto-deadlines]')) {
        setView('deadlines');
        return;
      }
      handleCardAction(e);
    });

    $('#openAssistantTop').addEventListener('click', () => openStudio());
    $('#openAssistantTeaser').addEventListener('click', () => openStudio());
    $('#closeStudio').addEventListener('click', closeStudio);
    $('#closeDrawer').addEventListener('click', closeDrawer);

    $('#drawerOverlay').addEventListener('click', () => {
      if ($('#filtersPanel').classList.contains('is-open') && window.innerWidth <= 900) {
        $('#filtersPanel').classList.remove('is-open');
        $('#mobileFilters').setAttribute('aria-expanded', 'false');
      }
      closeDrawer();
      closeStudio();
    });

    const setFiltersOpen = (open) => {
      $('#filtersPanel').classList.toggle('is-open', open);
      $('#mobileFilters').setAttribute('aria-expanded', String(open));
      $('#drawerOverlay').hidden = !open;
      document.body.classList.toggle('no-scroll', open);
    };

    $('#mobileFilters').addEventListener('click', () => {
      setFiltersOpen(!$('#filtersPanel').classList.contains('is-open'));
    });
    $('#closeFilters').addEventListener('click', () => setFiltersOpen(false));
    $('#applyFilters').addEventListener('click', () => {
      setFiltersOpen(false);
      $('#results').scrollIntoView({ behavior: 'instant', block: 'start' });
    });

    $('#checkSources').addEventListener('click', runSourceCheck);
    $('#checkSourcesMethod').addEventListener('click', runSourceCheck);
    $('#closeSource').addEventListener('click', closeSourceCheck);
    $('#sourceOverlay').addEventListener('click', closeSourceCheck);
    // One handler for the whole strip: it holds both the changed-source list and
    // the funds the daily search just added.
    $('#liveBar').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-open-fund]');
      if (!btn) return;
      openDrawer(btn.dataset.openFund);
    });
    $('#sourceBody').addEventListener('click', (e) => {
      if (e.target.closest('[data-daily]')) { startDailyUpdate(); return; }
      const ack = e.target.closest('[data-ack]');
      if (ack) { ackChanges([ack.dataset.ack]); return; }
      const all = e.target.closest('[data-ack-all]');
      if (all) { ackChanges(((liveState.payload || {}).pending || []).map((p) => p.id)); return; }
      const btn = e.target.closest('[data-open-fund]');
      if (!btn) return;
      closeSourceCheck();
      openDrawer(btn.dataset.openFund);
    });
    $('#openMethodology').addEventListener('click', openMethod);
    $('#openMethodologyTeaser').addEventListener('click', openMethod);
    $('#closeMethod').addEventListener('click', () => {
      $('#methodModal').hidden = true;
      if (isNothingOpen()) {
        $('#drawerOverlay').hidden = true;
        document.body.classList.remove('no-scroll');
      }
    });
    $('#methodOverlay').addEventListener('click', () => {
      $('#methodModal').hidden = true;
      $('#methodOverlay').hidden = true;
    });

    $$('.tab').forEach((tab) => {
      tab.addEventListener('click', () => setView(tab.dataset.view));
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeAllPanels();
        return;
      }
      if (e.key === '/' && state.view === 'search' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
        e.preventDefault();
        $('#searchInput').focus();
      }
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > 900 && $('#filtersPanel').classList.contains('is-open')) {
        $('#filtersPanel').classList.remove('is-open');
        $('#mobileFilters').setAttribute('aria-expanded', 'false');
        if (isNothingOpen()) $('#drawerOverlay').hidden = true;
        document.body.classList.remove('no-scroll');
      }
    });
  }

  function handleCardAction(e) {
    const open = e.target.closest('[data-open]');
    if (open) { openDrawer(open.dataset.open); return; }
    const draft = e.target.closest('[data-draft]');
    if (draft) { openStudio(draft.dataset.draft); return; }
    const save = e.target.closest('[data-save]');
    if (save) { toggleSave(save.dataset.save); }
  }

  function openMethod() {
    $('#methodModal').hidden = false;
    $('#methodOverlay').hidden = false;
    document.body.classList.add('no-scroll');
  }

  /* ---------- Source check ---------- */
  function sourceTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso || '';
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(d);
  }

  function closeSourceCheck() {
    $('#sourceModal').hidden = true;
    if (isNothingOpen()) {
      $('#sourceOverlay').hidden = true;
      document.body.classList.remove('no-scroll');
    }
  }

  let liveState = { status: 'idle', payload: null, problem: '', elapsed: 0 };
  let liveDismissed = false;
  let helperAvailable = false;

  function initLiveCheck() {
    $('#liveReview').addEventListener('click', () => runSourceCheck());
    $('#liveDismiss').addEventListener('click', () => {
      liveDismissed = true;
      $('#liveBar').hidden = true;
    });
    $('#liveFindFunds').addEventListener('click', () => startDailyUpdate());
    autoCheck();
  }

  /* ---------- Funds found automatically (tools/discover.py) ---------- */
  let autoFundsLoaded = false;

  function mergeFunds(list) {
    let added = 0;
    (list || []).forEach((fund) => {
      if (!fund || !fund.id || FUNDS.some((f) => f.id === fund.id)) return;
      FUNDS.push(fund);
      added += 1;
    });
    return added;
  }

  /* The daily update writes the funds it just found to data-check/new-funds.js,
     so they appear in the list without waiting for a reload. They are also in
     js/data.js, which is the permanent copy. */
  function loadAutoFunds(force = false) {
    return new Promise((resolve) => {
      if (autoFundsLoaded && !force) { resolve(0); return; }
      autoFundsLoaded = true;
      const script = document.createElement('script');
      script.src = `data-check/new-funds.js?v=${Date.now()}`;
      script.onload = () => resolve(mergeFunds(window.FUNDS_AUTO));
      script.onerror = () => resolve(0);
      document.head.appendChild(script);
    });
  }

  /* ---------- The daily update ---------- */
  let dailyState = { status: 'idle', info: null, problem: '' };
  let dailyPoll = null;

  function dailyResult(payload) {
    const info = dailyState.info || (payload && payload.daily) || null;
    return (info && info.result) || null;
  }

  async function startDailyUpdate(force = true) {
    if (dailyState.status === 'running') return;
    dailyState = { status: 'running', info: dailyState.info, problem: '' };
    renderLiveBar(liveState);
    if (!$('#sourceModal').hidden) renderSourceCheck(liveState.payload, '', 0);
    try {
      const res = await fetch('/api/daily', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ force }),
      });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).error || ''; } catch (err) { /* not JSON */ }
        throw new Error(detail || `the helper returned HTTP ${res.status}`);
      }
      const info = await res.json();
      dailyState = { status: 'running', info, problem: '' };
      if (!info.running && !info.started) { await finishDaily(info); return; }
      pollDaily();
    } catch (err) {
      dailyState = { status: 'error', info: null, problem: err.message };
      renderLiveBar(liveState);
      toast('Could not start the new-fund search — is tools/serve.py running?');
    }
  }

  function pollDaily(attempt = 0) {
    clearTimeout(dailyPoll);
    dailyPoll = setTimeout(async () => {
      try {
        const res = await fetch('/api/daily', { cache: 'no-store' });
        const info = await res.json();
        if (info.running && attempt < 75) {
          dailyState = { status: 'running', info, problem: '' };
          renderLiveBar(liveState);
          pollDaily(attempt + 1);
          return;
        }
        await finishDaily(info);
      } catch (err) {
        dailyState = { status: 'error', info: null, problem: err.message };
        renderLiveBar(liveState);
      }
    }, 4000);
  }

  async function finishDaily(info) {
    dailyState = { status: 'done', info, problem: '' };
    const result = (info && info.result) || null;
    const added = (result && result.added) || [];
    const merged = await loadAutoFunds(true);
    if (merged) { fillStudioSelect(); render(); }
    try {
      const res = await fetch('/api/latest', { cache: 'no-store' });
      if (res.ok) liveState = { status: 'done', payload: await res.json(), problem: '', elapsed: 0 };
    } catch (err) { /* keep the previous result */ }
    renderLiveBar(liveState);
    if (!$('#sourceModal').hidden && liveState.payload) renderSourceCheck(liveState.payload, '', 0);
    if (added.length) {
      toast(`${added.length} new fund${added.length === 1 ? '' : 's'} added to the list`);
    } else if (info && info.error) {
      toast('The new-fund search hit a problem — see the review panel');
    }
  }

  /* Runs on every load, without waiting for a click. The result is shown in the
     status strip above the page; the full report opens on demand. */
  async function autoCheck() {
    if (liveDismissed) return;
    renderLiveBar({ status: 'running', payload: liveState.payload });
    const result = await collectSourceCheck();
    liveState = { status: 'done', ...result };
    renderLiveBar(liveState);
    const changed = result.payload ? (result.payload.counts || {}).changed || 0 : 0;
    if (changed && !result.payload.cached) {
      toast(`${changed} source${changed === 1 ? '' : 's'} changed — new dates found`);
    }
    // The daily update runs on the helper's own clock; pick up a run in flight,
    // or start one when it has fallen due.
    const daily = result.payload && result.payload.daily;
    if (!helperAvailable) return;
    if (daily && daily.running) {
      dailyState = { status: 'running', info: daily, problem: '' };
      renderLiveBar(liveState);
      pollDaily();
    } else if (daily && daily.due) {
      startDailyUpdate(false);
    }
  }

  async function collectSourceCheck() {
    const started = Date.now();
    let payload = null;
    let problem = '';
    helperAvailable = false;

    // The helper only ever listens on loopback, so a deployed copy skips the
    // probe and goes straight to its saved result.
    const local = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
    if (local) {
      try {
        const health = await fetch('/api/health', { cache: 'no-store' });
        helperAvailable = health.ok;
      } catch (err) { /* static host, no helper */ }
    }

    if (helperAvailable) {
      try {
        const res = await fetch('/api/check', { method: 'POST', headers: { Accept: 'application/json' } });
        if (!res.ok) {
          let detail = '';
          try { detail = (await res.json()).error || ''; } catch (err) { /* not JSON */ }
          throw new Error(detail || `the helper returned HTTP ${res.status}`);
        }
        payload = await res.json();
      } catch (err) {
        problem = err.message;
      }
    } else {
      problem = 'the local helper is not running';
    }

    if (!payload) {
      try {
        const res = await fetch('data-check/latest.json', { cache: 'no-store' });
        if (res.ok) {
          payload = await res.json();
          payload.cached = true;
        }
      } catch (err) { /* no saved result */ }
    }

    return { payload, problem, elapsed: Date.now() - started };
  }

  function openSourcePanel(title, body) {
    closeAllPanels();
    $('#sourceOverlay').hidden = false;
    $('#sourceModal').hidden = false;
    document.body.classList.add('no-scroll');
    $('#sourceTitle').textContent = title;
    $('#sourceBody').innerHTML = body;
  }

  async function runSourceCheck() {
    openSourcePanel('Checking funder pages', `
      <p>Fetching ${FUNDS.length} funder pages and comparing them with the last saved snapshots. This usually takes 5–15 seconds.</p>
      <p class="modal__foot">The pages are read by the local helper in tools/serve.py — browsers cannot fetch other sites directly.</p>`);
    const result = await collectSourceCheck();
    liveState = { status: 'done', ...result };
    renderLiveBar(liveState);
    renderSourceCheck(result.payload, result.problem, result.elapsed);
  }

  async function ackChanges(ids) {
    if (!ids.length) return;
    try {
      const res = await fetch('/api/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      liveState = { status: 'done', payload, problem: '', elapsed: 0 };
      renderLiveBar(liveState);
      if (!$('#sourceModal').hidden) renderSourceCheck(payload, '', 0);
      toast(`Marked ${ids.length === 1 ? '1 change' : `${ids.length} changes`} reviewed`);
    } catch (err) {
      toast('Could not save that review — is tools/serve.py running?');
    }
  }

  function liveListItem(item) {
    const dates = (item.dates || []).slice(0, 2)
      .map((d) => `<span class="pill pill--check">${esc(d)}</span>`).join('');
    const money = (item.money || []).slice(0, 1)
      .map((m) => `<span class="pill">${esc(m)}</span>`).join('');
    const known = FUNDS.some((f) => f.id === item.id);
    return `<li>
      <span class="livebar__name">${esc(item.name)}</span>
      ${dates}${money}
      ${known ? `<button class="text-btn" type="button" data-open-fund="${esc(item.id)}">view</button>` : ''}
    </li>`;
  }

  function newFundItem(item) {
    const known = FUNDS.some((f) => f.id === item.id);
    return `<li>
      <span class="livebar__name">${esc(item.name)}</span>
      <span class="pill pill--auto">Auto-found</span>
      <span class="livebar__funder">${esc(item.funder || '')}</span>
      ${known ? `<button class="text-btn" type="button" data-open-fund="${esc(item.id)}">view</button>` : ''}
    </li>`;
  }

  function renderLiveBar(state) {
    const bar = $('#liveBar');
    if (!bar) return;
    if (liveDismissed) { bar.hidden = true; return; }
    const list = $('#liveList');
    const addedList = $('#liveAdded');
    const review = $('#liveReview');
    const find = $('#liveFindFunds');
    const p = state.payload;
    bar.hidden = false;
    const runningDaily = dailyState.status === 'running' || Boolean(p && p.daily_running);

    if (runningDaily) {
      bar.dataset.state = 'running';
      $('#liveText').innerHTML = "<strong>Searching the funders' own pages for new funds…</strong>";
      $('#liveMeta').textContent =
        'The daily update reads every monitored page and adds any programme it finds. This takes about a minute; you can keep using the list.';
      list.hidden = true;
      addedList.hidden = true;
      review.hidden = true;
      find.hidden = true;
      return;
    }

    if (state.status === 'running') {
      bar.dataset.state = 'running';
      $('#liveText').innerHTML = `<strong>Searching ${FUNDS.length} funder pages for new data…</strong>`;
      $('#liveMeta').textContent = p && p.run_at
        ? `showing the last saved result from ${sourceTime(p.run_at)} meanwhile`
        : 'this takes a few seconds';
      list.hidden = true;
      addedList.hidden = true;
      review.hidden = true;
      find.hidden = true;
      return;
    }

    if (!p) {
      bar.dataset.state = 'error';
      $('#liveText').innerHTML = '<strong>Live search unavailable</strong> — the local checker is not running';
      $('#liveMeta').textContent = 'Browsers cannot fetch other sites directly. Run python3 tools/serve.py and reload.';
      list.hidden = true;
      addedList.hidden = true;
      review.hidden = false;
      review.textContent = 'How to fix this';
      find.hidden = true;
      return;
    }

    const counts = p.counts || {};
    const pending = p.pending || [];
    const total = p.pending_total != null ? p.pending_total : pending.length;
    const result = dailyResult(p) || {};
    const newFunds = result.added || [];
    const waiting = result.queued_total || 0;
    bar.dataset.state = total || newFunds.length ? 'found' : 'clear';
    if (p.run_at && !p.cached) {
      const stamp = new Date(p.run_at);
      if (!Number.isNaN(stamp.getTime())) {
        $('#statVerified').textContent = fmtDate(stamp, { day: 'numeric', month: 'short' });
      }
    }
    const saved = p.cached ? ' — <em>saved result, not a live search</em>' : '';

    if (newFunds.length) {
      $('#liveText').innerHTML = `<strong>${newFunds.length} new fund${newFunds.length === 1 ? '' : 's'} found and added automatically</strong>${saved}`;
      addedList.innerHTML = newFunds.slice(0, 4).map(newFundItem).join('');
      addedList.hidden = false;
    } else {
      addedList.hidden = true;
      if (total) {
        $('#liveText').innerHTML = `<strong>${total} source${total === 1 ? ' has' : 's have'} changed since your last review</strong>${saved}`;
      } else {
        $('#liveText').innerHTML = `<strong>Nothing new on ${p.total} funder pages</strong>${saved}`;
      }
    }

    if (total) {
      list.innerHTML = pending.slice(0, 3).map(liveListItem).join('');
      list.hidden = false;
    } else {
      list.hidden = true;
    }
    review.hidden = false;
    review.textContent = total > 3 ? `Review all ${total}` : total ? 'Review' : 'Details';
    find.hidden = !helperAvailable;
    find.textContent = 'Find new funds';

    const bits = [`checked ${sourceTime(p.run_at)}`];
    if (!p.cached && state.elapsed) bits.push(`${Math.max(1, Math.round(state.elapsed / 1000))}s`);
    bits.push(`${counts.unchanged || 0} unchanged`);
    if (counts.blocked) bits.push(`${counts.blocked} blocked`);
    if (counts.unreachable) bits.push(`${counts.unreachable} unreachable`);
    if (result.run_at) bits.push(`daily update ${sourceTime(result.run_at)}`);
    if (waiting) bits.push(`${waiting} candidate${waiting === 1 ? '' : 's'} to review`);
    if (total && pending[0] && pending[0].first_seen) bits.push(`first seen ${sourceTime(pending[0].first_seen)}`);
    $('#liveMeta').textContent = bits.join(' · ');
  }

  function sourceItem(item, opts = {}) {
    const known = FUNDS.find((f) => f.id === item.id);
    const chips = [
      ...(item.dates || []).slice(0, 3).map((d) => `<span class="pill pill--check">${esc(d)}</span>`),
      ...(item.money || []).slice(0, 3).map((m) => `<span class="pill">${esc(m)}</span>`),
    ].join('');
    const signals = (item.signals || []).slice(0, 3)
      .map((line) => `<li>${esc(line.length > 200 ? line.slice(0, 197) + '…' : line)}</li>`).join('');
    const seen = item.first_seen ? ` · first seen ${esc(sourceTime(item.first_seen))}` : '';
    return `
      <article class="source-check__item">
        <div class="source-check__item-head">
          <h3>${esc(item.name)}</h3>
          <span class="source-check__tag">${esc(opts.tag || item.change || 'changed')}</span>
        </div>
        <p class="source-check__meta">${esc(item.funder || '')}${seen}</p>
        ${chips ? `<div class="source-check__chips">${chips}</div>` : ''}
        ${signals ? `<ul class="source-check__signals">${signals}</ul>` : ''}
        <div class="source-check__actions">
          <a class="text-btn" href="${esc(item.url)}" target="_blank" rel="noopener">Open source ↗</a>
          ${known ? `<button class="text-btn" type="button" data-open-fund="${esc(item.id)}">View fund in list</button>` : ''}
          ${opts.ack ? `<button class="text-btn" type="button" data-ack="${esc(item.id)}">Mark reviewed</button>` : ''}
        </div>
      </article>`;
  }

  function renderSourceCheck(payload, problem, elapsed) {
    const body = $('#sourceBody');
    if (!payload) {
      $('#sourceTitle').textContent = 'Source check unavailable';
      body.innerHTML = `
        <p><strong>Could not reach the local checker.</strong>${problem ? ` ${esc(problem)}.` : ''}</p>
        <p>Browsers block direct requests to other websites, so the button needs the small local helper. From the project folder run:</p>
        <pre class="source-check__code">python3 tools/serve.py</pre>
        <p>then open <strong>http://127.0.0.1:5173/</strong> and press <strong>Check sources</strong> again. To run a check without the browser:</p>
        <pre class="source-check__code">python3 tools/check_sources.py</pre>
        <p class="modal__foot">The rest of the site works without the helper; only the live check needs it.</p>`;
      return;
    }

    const counts = payload.counts || {};
    const items = payload.items || [];
    const pending = payload.pending || [];
    const changed = pending.length ? pending : items.filter((i) => i.change === 'changed');
    const problems = items.filter((i) => i.change === 'blocked' || i.change === 'unreachable');
    const baseline = items.filter((i) => i.change === 'baseline');
    const stale = payload.stale || [];
    const canAck = helperAvailable && !payload.cached;
    const seconds = Math.max(1, Math.round(elapsed / 1000));
    const took = elapsed > 0 && !payload.cached ? ` in ${seconds}s` : '';

    $('#sourceTitle').textContent = `Source check — ${sourceTime(payload.run_at) || payload.date || ''}`;
    if (payload.run_at) {
      $('#statVerified').textContent = fmtDate(new Date(payload.run_at), { day: 'numeric', month: 'short' });
    }

    body.innerHTML = `
      <p class="source-check__summary">
        ${payload.cached ? 'Last saved check' : 'Checked'} <strong>${payload.total} pages</strong>${took} ·
        <strong>${counts.changed || 0}</strong> changed ·
        <strong>${counts.blocked || 0}</strong> blocked ·
        <strong>${counts.unreachable || 0}</strong> unreachable
      </p>
      ${payload.cached ? `<p class="source-check__warn">The live helper was not running, so this is the last saved result${payload.run_at ? ` from ${esc(sourceTime(payload.run_at))}` : ''}. Start <code>tools/serve.py</code> for a fresh check.</p>` : ''}
      ${payload.coalesced ? `<p class="source-check__warn">A check was already running, so this is its result.</p>` : ''}
      ${payload.regression_note ? `<p class="source-check__warn">${esc(payload.regression_note)}</p>` : ''}
      ${dailySection(payload)}

      <h3>New or updated rounds</h3>
      ${changed.length
        ? `${changed.length > 1 && canAck ? `<p class="source-check__actions"><button class="text-btn" type="button" data-ack-all="1">Mark all ${changed.length} reviewed</button></p>` : ''}
           ${changed.map((item) => sourceItem(item, {
             tag: item.change || (item.runs > 1 ? 'changed again' : 'new'),
             ack: canAck,
           })).join('')}`
        : `<p>No monitored source has changed since your last review.</p>`}

      ${problems.length ? `
        <h3>Needs a manual look</h3>
        ${problems.map((item) => `
          <article class="source-check__item">
            <div class="source-check__item-head">
              <h3>${esc(item.name)}</h3>
              <span class="source-check__tag">${esc(item.change)}</span>
            </div>
            <p class="source-check__meta">${esc(item.error || item.note || 'The page could not be read.')}</p>
            <div class="source-check__actions">
              <a class="text-btn" href="${esc(item.url)}" target="_blank" rel="noopener">Open source ↗</a>
            </div>
          </article>`).join('')}` : ''}

      ${stale.length ? `
        <h3>Deadlines already in the past</h3>
        <ul class="source-check__stale">
          ${stale.map((s) => `<li><strong>${esc(s.name)}</strong> — ${esc(s.problem)} (${esc(s.closes)})</li>`).join('')}
        </ul>` : ''}

      ${baseline.length ? `<p class="modal__foot">${baseline.length} page${baseline.length === 1 ? '' : 's'} recorded a first baseline and will be diffed from the next run.</p>` : ''}
      <p class="modal__foot">A change means the page text differs from the last run — funders also edit news and banners. Open the source, confirm the round and dates, then update <code>js/data.js</code> by hand. Detected changes stay on this list for 30 days or until you mark them reviewed.</p>`;
  }

  /* The daily update, shown above the source changes it triggered. */
  function dailySection(payload) {
    const info = dailyState.info || (payload && payload.daily) || null;
    const running = dailyState.status === 'running' || Boolean(payload && payload.daily_running);
    const result = (info && info.result) || null;
    if (running) {
      return `<div class="source-check__daily">
        <h3>Daily update</h3>
        <p><strong>Running now</strong> — reading every monitored page and the funding directories for programmes that are not in the list yet. The results appear here when it finishes.</p>
      </div>`;
    }
    if (dailyState.status === 'error') {
      return `<div class="source-check__daily">
        <h3>Daily update</h3>
        <p class="source-check__warn">${esc(dailyState.problem || 'The last daily update could not be started.')} Start the helper with <code>python3 tools/serve.py</code>.</p>
      </div>`;
    }
    if (!info) {
      return `<div class="source-check__daily">
        <h3>Daily update</h3>
        <p>The helper searches for new funds once a day while it is running. Nothing has run yet.</p>
      </div>`;
    }
    const when = result && result.run_at ? sourceTime(result.run_at) : (info.last_run ? sourceTime(info.last_run) : 'not yet');
    const due = info.due ? ' · next run is due' : '';
    const added = (result && result.added) || [];
    const queued = (result && result.queued) || [];
    const notes = (result && result.notes) || [];
    return `<div class="source-check__daily">
      <h3>Daily update</h3>
      <p class="source-check__meta">Last run ${esc(when)}${result && result.duration_s ? ` · ${result.duration_s}s` : ''}${due}${info.enabled === false ? ' · switched off for this server' : ''}</p>
      ${notes.map((note) => `<p class="source-check__warn">${esc(note)}</p>`).join('')}
      ${added.length
        ? `<p><strong>${added.length} fund${added.length === 1 ? '' : 's'} added automatically</strong> — in the list, labelled <span class="pill pill--auto">Auto-found</span>:</p>
           <ul class="source-check__added">${added.map((item) => `<li><strong>${esc(item.name)}</strong> — ${esc(item.funder || '')}${FUNDS.some((f) => f.id === item.id) ? ` <button class="text-btn" type="button" data-open-fund="${esc(item.id)}">view in list</button>` : ''}<br><span class="source-check__meta">${esc(item.reason || '')} · found on <a href="${esc(item.seed || '')}" target="_blank" rel="noopener">${esc(shortHost(item.seed))}</a></span></li>`).join('')}</ul>`
        : '<p>No new funds were added on the last run.</p>'}
      ${queued.length
        ? `<h4>Candidates waiting for a human (${result.queued_total || queued.length})</h4>
           <ul class="source-check__queued">${queued.map((item) => `<li><a href="${esc(item.url)}" target="_blank" rel="noopener">${esc(item.name || item.url)}</a><br><span class="source-check__meta">${esc(item.reason || '')}</span></li>`).join('')}</ul>
           <p class="modal__foot">These were found but not added: the checker could not confirm them, or they arrived after the per-run limit. They are retried on a later run.</p>`
        : ''}
      <p class="source-check__actions"><button class="text-btn" type="button" data-daily="1">Search for new funds now</button></p>
    </div>`;
  }

  function shortHost(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (err) {
      return url || '';
    }
  }

  function resetFilters() {
    state.query = '';
    state.statuses.clear();
    state.categories.clear();
    state.scope = '';
    state.sizes.clear();
    state.types.clear();
    state.efforts.clear();
    state.deadline = '';
    state.orgType = '';
    state.confirmedOnly = false;
    state.hideAuto = false;
    $('#confirmedOnly').checked = false;
    $('#hideAuto').checked = false;
    $('#searchInput').value = '';
    $('#clearSearch').hidden = true;
    renderFilterChips();
    render();
    toast('Filters reset');
  }

  function setView(view) {
    state.view = view;
    const toolbar = $('.results__toolbar');
    if (toolbar) toolbar.hidden = view === 'tracker';
    const hero = $('.hero');
    if (hero) hero.hidden = view !== 'search';
    $$('.tab').forEach((tab) => {
      const active = tab.dataset.view === view;
      tab.classList.toggle('is-active', active);
      if (active) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    });
    $('#searchView').hidden = view !== 'search';
    $('#deadlinesView').hidden = view !== 'deadlines';
    $('#trackerView').hidden = view !== 'tracker';
    $('#resultsTitle').textContent = view === 'deadlines'
      ? 'Deadline calendar'
      : view === 'tracker' ? 'My tracker' : 'Funding opportunities';
    $('#filtersPanel').style.display = view === 'tracker' ? 'none' : '';
    $('.workspace').style.gridTemplateColumns = view === 'tracker' ? 'minmax(0, 1fr)' : '';
    // Filter sidebar is hidden in tracker view, so collapse the layout.
    if (view === 'tracker') {
      $('#filtersPanel').classList.remove('is-open');
    }
    if (view !== 'search') {
      $('#resultsMeta').textContent = '';
    }
    render();
    $('#results').scrollIntoView({ behavior: 'instant', block: 'start' });
  }

  /* ---------- Init ---------- */
  function fillStudioSelect() {
    const select = $('#studioGrant');
    const chosen = select.value;
    const rank = { 'closing-soon': 0, open: 1, rolling: 2, 'opening-soon': 3, announced: 4, closed: 5 };
    const sorted = FUNDS.slice().sort((a, b) =>
      rank[statusOf(a)] - rank[statusOf(b)] || a.name.localeCompare(b.name));
    select.innerHTML = sorted
      .map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`)
      .join('');
    select.value = FUNDS.some((f) => f.id === chosen) ? chosen : 'afl-england';
  }

  function init() {
    renderFilterChips();
    fillStudioSelect();

    const verified = parseYMD(VERIFIED);
    $('#statVerified').textContent = fmtDate(verified, { day: 'numeric', month: 'short' });
    $('#statTotal').textContent = String(FUNDS.length);

    bindEvents();
    updateTrackerBadge();
    render();
    initLiveCheck();

    // Funds added by the last daily update, so they are in the list even before
    // js/data.js is re-read by a reload.
    loadAutoFunds().then((added) => {
      if (!added) return;
      fillStudioSelect();
      render();
    });

    window.CFF = {
      funds: FUNDS,
      statusOf,
      statusLabel: (f) => STATUS_META[statusOf(f)].label,
      deadlineInfo,
      awardRange,
      money,
      fmtDate,
      fmtMoment,
      parseYMD,
      openStudio,
      openDrawer,
      toast,
      checkSources: runSourceCheck,
      refreshSources: autoCheck,
      liveState: () => liveState,
      findNewFunds: startDailyUpdate,
      dailyState: () => dailyState,
      loadAutoFunds,
      getTracker,
      saveTracker,
      isSaved,
      profileKey: PROFILE_KEY,
    };
  }

  document.addEventListener('DOMContentLoaded', init);
})();
