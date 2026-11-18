/* Application studio — grant-aware drafting that works offline,
   with an optional connection to your own model provider. */

(function () {
  'use strict';

  const PROFILE_KEY = 'cicff.profile.v1';
  const MODEL_KEY = 'cicff.model.v1';
  const DRAFT_KEY = 'cicff.drafts.v1';

  const PROVIDERS = {
    openai: { label: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', needsKey: true },
    anthropic: { label: 'Anthropic', url: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-5', needsKey: true },
    groq: { label: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', needsKey: true },
    ollama: { label: 'Ollama (local)', url: 'http://localhost:11434/v1/chat/completions', model: 'llama3.2', needsKey: false },
  };

  const $ = (sel) => document.querySelector(sel);
  const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ORG = {
    cic: {
      label: 'a Community Interest Company',
      short: 'CIC',
      governance:
        'As a CIC we are a regulated social enterprise. Our asset lock means any surplus is reinvested in our community purpose rather than distributed, and we report each year to the CIC Regulator. That structure keeps decisions close to the people we serve.',
    },
    charity: {
      label: 'a registered charity',
      short: 'charity',
      governance:
        'As a registered charity, we are governed by a board of trustees and accountable to the charity regulator. Our governing document commits us to our charitable purposes, and our annual report and accounts are publicly available.',
    },
    nonprofit: {
      label: 'a not-for-profit community organisation',
      short: 'non-profit',
      governance:
        'As a not-for-profit organisation, our constitution prevents any surplus being distributed to members. We are accountable to our members and the community we serve, and we publish our accounts and trustee decisions.',
    },
  };

  const profileFields = {
    orgType: '#pOrgType',
    name: '#pName',
    place: '#pPlace',
    mission: '#pMission',
    people: '#pPeople',
    track: '#pTrack',
    project: '#pProject',
    amount: '#pAmount',
    tone: '#pTone',
    words: '#pWords',
  };

  let profile = readJSON(PROFILE_KEY, {});
  let model = readJSON(MODEL_KEY, { provider: 'openai', model: '', key: '' });
  let drafts = readJSON(DRAFT_KEY, {});
  let generating = false;

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
      /* storage may be unavailable — drafts remain in the textarea */
    }
  }

  function debounce(fn, wait) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function wordCount(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean).length;
  }

  function fund() {
    const id = $('#studioGrant').value;
    return window.CFF.funds.find((f) => f.id === id) || window.CFF.funds[0];
  }

  function orgMeta() {
    return ORG[profile.orgType] || ORG.cic;
  }

  function updateGrantMeta() {
    const f = fund();
    const el = $('#studioGrantMeta');
    if (!f || !el) return;
    el.textContent = `${f.funder} · ${window.CFF.awardRange(f)} · ${window.CFF.statusLabel(f)}`;
  }

  function questionLabel() {
    const select = $('#studioQuestion');
    if (select.value === 'custom') {
      return $('#customQuestion').value.trim() || 'A custom question';
    }
    return select.options[select.selectedIndex].textContent;
  }

  function amountLabel() {
    const typed = Number(profile.amount);
    if (typed > 0) return '£' + typed.toLocaleString('en-GB');
    const f = fund();
    if (f.awardMax) {
      const range = window.CFF.awardRange(f);
      return /^up to /i.test(range) ? range : 'up to ' + range.replace('–', ' to ');
    }
    return '[amount requested]';
  }

  function firstName(str) {
    return String(str || '').replace(/^The\s+/i, '').replace(/\.$/, '');
  }

  /* ---------- Draft engine ---------- */

  function context() {
    const f = fund();
    const p = profile;
    return {
      f,
      org: (p.name || '').trim() || '[your organisation name]',
      orgType: ORG[p.orgType] ? p.orgType : 'cic',
      orgLabel: orgMeta().label,
      place: (p.place || '').trim() || '[your area]',
      mission: (p.mission || '').trim() || '[what your organisation exists to change]',
      people: (p.people || '').trim() || '[who you work with]',
      track: (p.track || '').trim() || '',
      project: (p.project || '').trim() || '[describe the activity you would deliver]',
      amount: amountLabel(),
      priority: (f.priorities[0] || 'community benefit').toLowerCase(),
      priority2: (f.priorities[1] || '').toLowerCase(),
      tone: p.tone || 'plain',
      limit: Number(p.words) || 400,
      custom: $('#customQuestion').value.trim(),
    };
  }

  function opening(c) {
    const purpose = c.mission.replace(/^to\s+/i, '');
    if (c.tone === 'warm') {
      return `${c.org} is rooted in ${c.place}. We are ${c.orgLabel}, and we exist to ${purpose}.`;
    }
    if (c.tone === 'formal') {
      return `${c.org} is ${c.orgLabel} operating in ${c.place}. Its purpose is to ${purpose}.`;
    }
    return `${c.org} is ${c.orgLabel} working in ${c.place}. We exist to ${purpose}.`;
  }

  function gapSentence(c) {
    return c.track
      ? `Our evidence comes from our own delivery. ${capitalise(c.track)}${/[.!?]$/.test(c.track) ? '' : '.'}`
      : 'Our evidence comes from [insert your evidence: referrals, waiting lists, survey data, participant feedback] — add one or two local statistics with their source and date.';
  }

  function capitalise(text) {
    const s = String(text || '').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function evidenceSentence(c) {
    if (!c.track) {
      return 'We can provide evidence of delivery, partner references and participant feedback. [Insert your strongest numbers and dates.]';
    }
    const t = c.track.trim();
    return capitalise(t) + (/[.!?]$/.test(t) ? '' : '.');
  }

  function draftFor(question, c) {
    const f = c.f;
    const blocks = {};

    blocks.organisation = [
      opening(c),
      `We work with ${c.people}. ${evidenceSentence(c)}`,
      orgMeta().governance,
      `We are applying to ${f.funder} because ${f.name} prioritises ${c.priority}. This is where our work already sits.`,
    ];

    blocks.need = [
      `The need we are responding to is concentrated among ${c.people} in ${c.place}. [Describe the local problem in two sentences: what is happening, to whom, and why now.]`,
      gapSentence(c),
      `If nothing changes, [describe the consequence for people and place]. Existing services [explain the gap you fill — not that there is "no provision", unless that is literally true].`,
      `This speaks directly to ${f.funder}'s priority to ${c.priority}. Funding would let us [state the change you would make], rather than simply continue what already exists.`,
    ];

    blocks.project = [
      `With a grant of ${c.amount} from ${f.funder}, ${c.org} would deliver ${firstName(c.project)} in ${c.place}, working with ${c.people}. [State the project length and start date.]`,
      `Delivery would have three parts: [1. what happens first], [2. the core activity], and [3. how participants shape what comes next]. Sessions or activities would run [frequency and length] at [venue], with [accessibility, transport or childcare support].`,
      `The work would be led by [role], supported by [partners or volunteers]. [Name the experience that makes you credible here.]`,
      `We expect to reach [number] people, with [number] taking part regularly. Success would look like [two or three concrete changes in people's lives].`,
    ];

    blocks.beneficiaries = [
      `The project is designed with and for ${c.people}. We expect to reach [number] people, including [describe the groups who face the biggest barriers].`,
      `People will shape the work through [a steering group, regular feedback, co-design sessions]. [Name a decision participants have made or will make, rather than describing consultation alone.]`,
      `We will remove practical barriers by covering [cost, transport, childcare, language, accessibility, timing]. [Explain how you know these are the barriers.]`,
      c.track ? `Our existing relationships are the starting point. ${evidenceSentence(c)}` : 'We will recruit through [existing partners and networks], not cold advertising.',
      `We will track who takes part by [method] so we can see who we are missing, not only who turns up.`,
    ];

    blocks.outcomes = [
      `We would work towards three outcomes. First, [outcome for individuals — be specific about the change]. Second, [outcome for the wider community or place]. Third, [organisational or system outcome].`,
      `We will measure progress using [survey, interviews, attendance data, partner feedback] at [baseline, mid-point and end]. [Name who collects it and how participants are involved.]`,
      `Our starting point is [baseline figure or description]. Success would be [target] by [date]. If progress stalls, we will [adapt the model / change recruitment / seek partner support].`,
      `We will share learning with ${f.funder} through [report, case studies, learning event], including what did not work.`,
    ];

    blocks.budget = [
      `The total cost of this work is £[total]. We are requesting ${c.amount} from ${f.funder}, with [£amount] from [other source] and [in-kind contributions] from [partner].`,
      `The budget covers [staff costs], [activity and delivery], [venue and travel], [monitoring and evaluation], and [a realistic share of core costs]. [Add the percentage each represents.]`,
      `Value for money comes from [cost per participant], [partner contributions], [volunteer time valued at £X], and [use of existing assets or relationships]. [Compare to local alternatives if you can.]`,
      `[Explain any unusual line item. State what you would do if costs rise or the grant is smaller than requested.]`,
    ];

    blocks.sustainability = [
      `The grant would fund [phase one: establish the work and prove the model]. Beyond that, [describe the plan for continuing it].`,
      `We would diversify income through [earned income, contracts, other trusts, individual giving, local authority commissioning]. [Give a realistic timeline and target.]`,
      `Partners [names] have committed [what], and [describe any match funding or shared delivery].`,
      `As a CIC, our trading model and asset lock make this work accountable to the community it serves. [Explain how the work would remain rooted in the community after the grant.]`,
    ];

    const structure = {
      cic: {
        status: `Our community interest statement commits us to ${c.mission.replace(/^to\s+/i, '')}, and our asset lock means assets and surpluses stay with the community.`,
        board: 'Our board includes [people with lived experience, local residents, independent professionals], and we publish an annual report to the CIC Regulator. [Describe how the board is accountable to the community.]',
        why: 'The CIC structure suits this work because [reasons: trading income reduces grant dependence, community ownership, transparency]. It also means we cannot distribute profits to shareholders — which matters when public money is involved.',
      },
      charity: {
        status: `Our charitable purposes commit us to ${c.mission.replace(/^to\s+/i, '')}, and our trustees are accountable to the charity regulator for how we use every grant.`,
        board: 'Our trustee board includes [people with lived experience, local residents, independent professionals], and we publish an annual report and accounts. [Describe how trustees stay connected to the community.]',
        why: 'The charitable structure suits this work because [reasons: charitable objects match the purpose, public accountability, access to charitable funding]. It also means our assets are held for public benefit rather than private gain.',
      },
      nonprofit: {
        status: `Our constitution commits us to ${c.mission.replace(/^to\s+/i, '')}, and prevents any surplus being distributed to members.`,
        board: 'Our committee includes [people with lived experience, local residents, independent professionals], and we publish minutes and accounts to members. [Describe how members hold the committee to account.]',
        why: 'The not-for-profit structure suits this work because [reasons: community ownership, low overheads, flexibility, member accountability]. It also means every pound stays with the community rather than going to shareholders.',
      },
    }[c.orgType];

    blocks.structure = [
      `${c.org} is ${c.orgLabel}. ${structure.status}`,
      structure.board,
      structure.why,
      `We are applying to ${f.funder} as ${c.orgLabel} with [track record / readiness], and we can evidence the governance, accounts and policies a grant of this size requires.`,
    ];

    const custom = [
      `[Restate the question in one sentence in your own words, then answer it directly: ${c.custom || 'your custom question'}.]`,
      `${opening(c)} ${evidenceSentence(c)}`,
      `Our answer draws on ${c.place} and the people we work with: ${c.people}. [Give one concrete example that proves the point.]`,
      `This matters to ${f.funder} because the fund prioritises ${c.priority}. [Link your answer to that priority explicitly.]`,
      `[Close by stating what you would do next and what you would need from this fund.]`,
    ];

    const extras = {
      organisation: [
        `Our board has [number] directors, including [lived experience and local residents]. We meet [frequency], publish minutes and use [committees] to oversee finance and safeguarding. [Add any accreditation or quality mark.]`,
        `We work with [partner names], who bring [what they contribute]. [Explain how the partnership improves reach or delivery rather than simply adding a logo.]`,
        `We are applying now because [trigger or momentum]. This grant would let us [specific step change], not simply maintain what already exists.`,
      ],
      need: [
        `Local context: around [population figure] people live in ${c.place}, and [local statistic with source and date]. [Explain what the figure does not show.]`,
        `We hear this directly from participants: [quote or paraphrase]. [Say how you gathered this and how often.]`,
        `The gap is not a lack of demand but [what is missing: capacity, accessibility, affordability, continuity]. [Explain why existing provision does not reach this group.]`,
      ],
      project: [
        `Timeline: [month — recruitment and set-up], [month — delivery starts], [month — mid-point review], [month — sharing and evaluation]. We would review progress with participants at each stage.`,
        `Staffing and safeguarding: [roles and hours], with [ratios] and [DBS, training and supervision arrangements]. [Name who is accountable if something goes wrong.]`,
        `The main risk is [risk]. We would manage it by [action], and if [scenario] happened we would [contingency]. [Mention any dependency on a partner or venue.]`,
      ],
      beneficiaries: [
        `We will reach people through [referral routes and partners], not only our existing contacts. [Explain how you will reach those who are least likely to come forward.]`,
        `Access: [adjustments — transport, childcare, interpreters, quiet spaces, online options]. We will ask participants what would make it easier rather than assume.`,
        `Safeguarding and consent: [policies], [staff training] and [how consent is recorded], including for photographs, case studies and data.`,
      ],
      outcomes: [
        `We will use [tool or method] because it is proportionate, comparable and can be completed with support. [Explain who collects it and when.]`,
        `Participants will help interpret the findings in [session or workshop], so the learning is not extracted from the community.`,
        `We will report to ${f.funder} [frequency] and publish [what] openly, including what did not work and what we changed as a result.`,
      ],
      budget: [
        `Budget breakdown: [staff £X], [activity £X], [venue and travel £X], [evaluation £X], [core costs £X]. [State the percentage of total costs requested.]`,
        `We have [match funding or in-kind support] confirmed from [source], and [evidence — letter, contract or board decision].`,
        `If costs change, we would [plan] and agree any material change with the funder before spending. [Explain your financial controls.]`,
      ],
      sustainability: [
        `Year one: the grant pays for [activity and set-up]. Year two: [income or delivery plan]. Year three: [target and who pays].`,
        `We have already [asset, relationship or contract] that reduces the risk of depending on a single funder. [Give the detail.]`,
        `If funding ended tomorrow, [what would continue] because [reason]. We would protect [the part of the work that matters most to participants].`,
      ],
      structure: [
        c.orgType === 'cic'
          ? 'Our community interest statement is reviewed annually, and our asset lock is written into our articles. [Say where the clause is and who checks it.]'
          : c.orgType === 'charity'
            ? 'Our charitable objects and trustee responsibilities are set out in our governing document, and we report annually to the charity regulator. [Name the document and who reviews it.]'
            : 'Our constitution sets out our purposes, membership and rules for distributing any surplus. [Name the clause and who checks it.]',
        `We involve [members, participants or residents] in governance through [mechanism], and our accounts and annual report are available on request.`,
        `We are applying to ${f.funder} because ${c.priority} is central to our purpose, and our structure gives the funder confidence that the grant stays in the community.`,
      ],
      custom: [],
    };

    const map = {
      organisation: blocks.organisation,
      need: blocks.need,
      project: blocks.project,
      beneficiaries: blocks.beneficiaries,
      outcomes: blocks.outcomes,
      budget: blocks.budget,
      sustainability: blocks.sustainability,
      structure: blocks.structure,
      custom,
    };

    const base = map[question] || custom;
    const extra = extras[question] || [];
    const closing = base.slice(-1);
    return base.slice(0, -1).concat(extra, closing);
  }

  function trimToLimit(paragraphs, limit) {
    const kept = paragraphs.slice();
    let text = kept.join('\n\n');
    while (wordCount(text) > limit && kept.length > 2) {
      kept.pop();
      text = kept.join('\n\n');
    }
    if (wordCount(text) > limit) {
      const sentences = text.split(/(?<=[.!?])\s+/);
      while (wordCount(sentences.join(' ')) > limit && sentences.length > 1) sentences.pop();
      text = sentences.join(' ');
    }
    return text;
  }

  function buildNotes(c) {
    const f = c.f;
    const missing = [];
    if (!profile.name) missing.push('organisation name');
    if (!profile.place) missing.push('where you work');
    if (!profile.mission) missing.push('your mission');
    if (!profile.people) missing.push('who you work with');
    if (!profile.track) missing.push('track record or local evidence');
    if (!profile.project) missing.push('what you would do with the grant');
    if (!Number(profile.amount)) missing.push('amount requested');

    const orgType = ORG[profile.orgType] ? profile.orgType : 'cic';
    const governanceDoc = orgType === 'cic'
      ? 'Governing document and CIC community interest statement'
      : orgType === 'charity'
        ? 'Governing document and charity registration details'
        : 'Constitution and trustee or committee details';
    const docs = [
      governanceDoc,
      'Latest annual accounts and management accounts',
      'Project budget with quotes for large items',
      'Bank details in the organisation’s name',
    ];
    if (f.categories.includes('Children & young people')) docs.push('Safeguarding policy and named safeguarding lead');
    if (f.effort !== 'Light') docs.push('Delivery plan and evaluation framework');
    if (f.fundingType === 'Social investment') docs.push('Cash-flow forecast and repayment plan');

    const missingHTML = missing.length
      ? `<strong>Fill these in for a sharper draft</strong><ul>${missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>`
      : '<strong>Profile complete.</strong> Replace the [bracketed prompts] with your own evidence before submitting.';

    const flags = [];
    const requested = Number(profile.amount);
    if (requested && f.awardMax && requested > f.awardMax) {
      flags.push(`You have asked for £${requested.toLocaleString('en-GB')}, but the published maximum is ${window.CFF.awardRange(f)}. Reduce the ask or phase the work.`);
    }
    if (requested && f.awardMin && requested < f.awardMin) {
      flags.push(`The published minimum for this fund is ${window.CFF.money(f.awardMin)}; your ask of £${requested.toLocaleString('en-GB')} is below it.`);
    }
    const eligibility = (f.orgTypes && f.orgTypes[orgType]) || 'check';
    if (eligibility === 'no') {
      flags.push(`This programme does not accept ${orgMeta().short} applicants. Check whether a partner organisation can lead the application.`);
    } else if (eligibility !== 'yes') {
      flags.push(`${orgMeta().short[0].toUpperCase() + orgMeta().short.slice(1)} eligibility is not confirmed for this programme — check with the funder before writing.`);
    }
    const currentStatus = window.CFF.statusOf(f);
    if (currentStatus === 'closed' || currentStatus === 'announced') {
      flags.push('This programme is not currently open. Use the draft to prepare for the next round.');
    }
    const flagsHTML = flags.length
      ? `<strong style="margin-top:8px">Check before you write</strong><ul>${flags.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
      : '';

    return `
      ${missingHTML}
      ${flagsHTML}
      <strong style="margin-top:8px">What ${esc(f.funder)} reviewers look for</strong>
      <ul>${f.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      <strong style="margin-top:8px">Usually requested with the application</strong>
      <ul>${docs.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
      <strong style="margin-top:8px">Before you submit</strong>
      <ul>
        <li>Check the word limit and paste only the answer, without headings unless asked.</li>
        <li>Replace every [bracket] with a real number, name or example.</li>
        <li>Ask someone outside the project to read it for clarity.</li>
        <li>Confirm the deadline on the funder’s page — dates in this tool are a snapshot.</li>
      </ul>`;
  }

  function updateWordCount() {
    const count = wordCount($('#draftOutput').value);
    const limit = Number(profile.words) || 400;
    $('#wordCount').textContent = count ? `${count} / ${limit} words` : '';
  }

  function setOutput(text, noteHTML, status) {
    $('#draftOutput').value = text;
    updateWordCount();
    if (noteHTML) {
      $('#draftNotes').innerHTML = noteHTML;
      $('#draftNotes').hidden = false;
    }
    $('#draftStatus').textContent = status;
    const hasText = Boolean(text.trim());
    $('#copyDraft').disabled = !hasText;
    $('#downloadDraft').disabled = !hasText;
    $('#clearDraft').disabled = !hasText;
    saveDraft();
  }

  /* ---------- Draft persistence ---------- */
  function draftKey() {
    const q = $('#studioQuestion').value === 'custom'
      ? 'custom:' + ($('#customQuestion').value.trim() || 'question')
      : $('#studioQuestion').value;
    return `${$('#studioGrant').value}|${q}`;
  }

  const saveDraft = debounce(() => {
    const text = $('#draftOutput').value;
    if (text.trim()) {
      drafts[draftKey()] = { text, updated: new Date().toISOString() };
    } else {
      delete drafts[draftKey()];
    }
    writeJSON(DRAFT_KEY, drafts);
  }, 600);

  function loadDraft() {
    const saved = drafts[draftKey()];
    if (saved && saved.text) {
      $('#draftOutput').value = saved.text;
      $('#draftNotes').hidden = true;
      $('#draftStatus').textContent = 'Saved draft restored';
      updateWordCount();
      ['copyDraft', 'downloadDraft', 'clearDraft'].forEach((id) => { $('#' + id).disabled = false; });
      return true;
    }
    $('#draftOutput').value = '';
    $('#draftNotes').hidden = true;
    $('#draftStatus').textContent = 'Ready when you are';
    updateWordCount();
    ['copyDraft', 'downloadDraft', 'clearDraft'].forEach((id) => { $('#' + id).disabled = true; });
    return false;
  }

  /* ---------- Profile and model persistence ---------- */
  function loadProfileIntoForm() {
    Object.entries(profileFields).forEach(([key, selector]) => {
      const el = $(selector);
      if (el && profile[key] != null) el.value = profile[key];
    });
    if (!profile.words) profile.words = '400';
    $('#pWords').value = profile.words;
    $('#profileHint').textContent = profile.name ? `Saved · ${profile.name}` : 'Used to personalise drafts';
  }

  const saveProfile = debounce(() => {
    writeJSON(PROFILE_KEY, profile);
    $('#profileHint').textContent = profile.name ? `Saved · ${profile.name}` : 'Used to personalise drafts';
  }, 350);

  function loadModelIntoForm() {
    const provider = model.provider || 'openai';
    $('#providerSelect').value = provider;
    $('#modelName').value = model.model || '';
    $('#modelName').placeholder = PROVIDERS[provider].model;
    $('#apiKey').value = model.key || '';
    updateModelDot();
  }

  function updateModelDot() {
    const connected = Boolean(model.key) || model.provider === 'ollama';
    $('#modelDot').classList.toggle('is-connected', connected);
    $('#modelStatus').textContent = connected
      ? `Connected to ${PROVIDERS[model.provider]?.label || model.provider}${model.model ? ` · ${model.model}` : ''}.`
      : 'Offline drafting works without a model.';
    $('#modelStatus').classList.remove('is-error');
  }

  /* ---------- AI generation ---------- */
  function buildPrompt(questionText) {
    const c = context();
    const f = c.f;
    return `You are an experienced UK grant writer working with community organisations, including CICs, charities and non-profits. Write in British English, in the first person plural ("we").

FUND
Name: ${f.name}
Funder: ${f.funder}
Award range: ${window.CFF.awardRange(f)}
Funder priorities: ${f.priorities.join('; ')}
Eligibility notes: ${f.eligibility.join(' ')}
What reviewers look for: ${f.tips.join(' ')}

APPLICANT
Organisation: ${c.org}
Legal form: ${c.orgLabel}
Location: ${c.place}
Mission: ${c.mission}
People served: ${c.people}
Track record: ${c.track || 'not supplied'}
Project idea: ${c.project}
Amount requested: ${c.amount}

TASK
Answer this application question: "${questionText}"

REQUIREMENTS
- Maximum ${c.limit} words. Tone: ${c.tone}.
- Be specific and concrete. Use short paragraphs.
- Never invent statistics, partner names, dates or outcomes. Where evidence is missing, insert a clearly marked placeholder like [INSERT: local statistic with source].
- Reference the funder's priorities naturally, not as a list.
- Do not include a preamble, headings or explanations. Return only the answer text.`;
  }

  async function generateWithAI() {
    if (generating) return;
    const questionText = questionLabel();
    const c = context();
    const providerKey = $('#providerSelect').value;
    const provider = PROVIDERS[providerKey] || PROVIDERS.openai;
    const apiKey = $('#apiKey').value.trim();

    if (!apiKey && provider.needsKey) {
      $('#modelPanel').open = true;
      setModelStatus('Add an API key first, or use the offline draft builder.', true);
      return;
    }

    const modelName = $('#modelName').value.trim() || provider.model;
    model = { provider: providerKey, model: modelName, key: apiKey };
    writeJSON(MODEL_KEY, model);
    updateModelDot();
    const prompt = buildPrompt(questionText);

    generating = true;
    $('#generateAI').disabled = true;
    $('#draftStatus').textContent = `Writing with ${modelName}…`;
    $('#draftNotes').hidden = true;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    try {
      let text = '';
      if (providerKey === 'anthropic') {
        const res = await fetch(provider.url, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({
            model: modelName,
            max_tokens: Math.max(600, Math.round(c.limit * 2.2)),
            system: 'You are an experienced UK grant writer for community organisations, including CICs, charities and non-profits. Never invent facts. Return only the requested answer text.',
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        if (!res.ok) throw new Error(await readError(res));
        const data = await res.json();
        text = (data.content || []).map((part) => part.text || '').join('').trim();
      } else {
        const res = await fetch(provider.url, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: modelName,
            temperature: 0.6,
            messages: [
              { role: 'system', content: 'You are an experienced UK grant writer for community organisations, including CICs, charities and non-profits. Never invent facts. Return only the requested answer text.' },
              { role: 'user', content: prompt },
            ],
          }),
        });
        if (!res.ok) throw new Error(await readError(res));
        const data = await res.json();
        text = (data.choices?.[0]?.message?.content || '').trim();
      }

      if (!text) throw new Error('The model returned an empty response.');
      setOutput(text, buildNotes(c), `AI draft · ${modelName}`);
      setModelStatus('Draft generated. Check every factual claim before submitting.');
    } catch (err) {
      const message = err.name === 'AbortError'
        ? 'The request timed out. Try a shorter word limit or another model.'
        : (err instanceof TypeError || err.message === 'Failed to fetch')
          ? 'Could not reach the provider. Check your connection, or that your local model is running.'
          : err.message || 'The request failed.';
      $('#draftStatus').textContent = 'AI request failed';
      setModelStatus(message, true);
      if (!$('#draftOutput').value.trim()) {
        $('#draftNotes').innerHTML = `<strong>Could not reach the model</strong> ${esc(message)} You can still use “Build my draft” for an offline scaffold.`;
        $('#draftNotes').hidden = false;
      }
    } finally {
      clearTimeout(timeout);
      generating = false;
      $('#generateAI').disabled = false;
    }
  }

  async function readError(res) {
    let detail = '';
    try {
      const data = await res.json();
      detail = data.error?.message || data.message || '';
    } catch (err) {
      detail = '';
    }
    if (res.status === 401 || res.status === 403) return `Authentication failed (${res.status}). Check your API key and model access. ${detail}`.trim();
    if (res.status === 429) return 'Rate limit reached. Wait a moment or try another model.';
    return `Provider error ${res.status}. ${detail}`.trim();
  }

  function setModelStatus(message, isError) {
    const el = $('#modelStatus');
    el.textContent = message;
    el.classList.toggle('is-error', Boolean(isError));
  }

  /* ---------- Events ---------- */
  function bind() {
    // Profile inputs
    Object.entries(profileFields).forEach(([key, selector]) => {
      const el = $(selector);
      if (!el) return;
      el.addEventListener('input', () => {
        profile[key] = el.value;
        saveProfile();
        updateWordCount();
      });
      el.addEventListener('change', () => {
        profile[key] = el.value;
        saveProfile();
        updateWordCount();
      });
    });

    $('#studioQuestion').addEventListener('change', () => {
      const isCustom = $('#studioQuestion').value === 'custom';
      $('#customQuestionWrap').hidden = !isCustom;
      loadDraft();
      if (isCustom) $('#customQuestion').focus();
    });

    $('#customQuestion').addEventListener('input', debounce(loadDraft, 250));

    $('#studioGrant').addEventListener('change', () => {
      updateGrantMeta();
      loadDraft();
      const f = fund();
      $('#draftStatus').textContent = `${f.name} · ${window.CFF.statusLabel(f)}`;
      setModelStatus(model.key || model.provider === 'ollama' ? 'Ready to generate.' : 'Offline drafting works without a model.');
    });

    document.addEventListener('studio:open', (e) => {
      const f = window.CFF.funds.find((x) => x.id === e.detail.fundId);
      if (f && !$('#draftOutput').value.trim()) {
        $('#draftStatus').textContent = `${f.name} · ${window.CFF.statusLabel(f)}`;
      }
      if ($('#profileDetails') && !profile.name) $('#profileDetails').open = true;
      updateGrantMeta();
      loadDraft();
    });

    $('#generateDraft').addEventListener('click', () => {
      const c = context();
      const paragraphs = draftFor($('#studioQuestion').value, c);
      const text = trimToLimit(paragraphs, c.limit);
      setOutput(text, buildNotes(c), `Draft built for ${c.f.name}`);
      $('#draftStatus').textContent = `Offline draft · ${wordCount(text)} words`;
    });

    $('#draftOutput').addEventListener('input', () => {
      updateWordCount();
      const hasText = Boolean($('#draftOutput').value.trim());
      ['copyDraft', 'downloadDraft', 'clearDraft'].forEach((id) => { $('#' + id).disabled = !hasText; });
      saveDraft();
    });

    $('#copyDraft').addEventListener('click', async () => {
      const text = $('#draftOutput').value;
      try {
        await navigator.clipboard.writeText(text);
        window.CFF.toast('Draft copied to clipboard');
      } catch (err) {
        $('#draftOutput').select();
        document.execCommand('copy');
        window.CFF.toast('Draft copied');
      }
    });

    $('#downloadDraft').addEventListener('click', () => {
      const c = context();
      const lines = [
        `# ${c.f.name} — application draft`,
        '',
        `**Funder:** ${c.f.funder}`,
        `**Question:** ${questionLabel()}`,
        `**Prepared:** ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`,
        `**Award range:** ${window.CFF.awardRange(c.f)}`,
        `**Deadline:** ${c.f.dateNote}`,
        '',
        '---',
        '',
        $('#draftOutput').value,
        '',
        '---',
        '',
        `Funder page: ${c.f.applyUrl}`,
        'Check every date and eligibility rule on the funder’s site before submitting.',
      ];
      const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `draft-${c.f.id}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      window.CFF.toast('Draft downloaded');
    });

    $('#clearDraft').addEventListener('click', () => {
      $('#draftOutput').value = '';
      $('#draftNotes').hidden = true;
      delete drafts[draftKey()];
      writeJSON(DRAFT_KEY, drafts);
      updateWordCount();
      ['copyDraft', 'downloadDraft', 'clearDraft'].forEach((id) => { $('#' + id).disabled = true; });
      $('#draftStatus').textContent = 'Cleared';
    });

    $('#providerSelect').addEventListener('change', () => {
      const provider = $('#providerSelect').value;
      $('#modelName').value = '';
      $('#modelName').placeholder = PROVIDERS[provider].model;
      $('#apiKey').required = PROVIDERS[provider].needsKey;
      setModelStatus('');
    });

    $('#saveModel').addEventListener('click', () => {
      model = {
        provider: $('#providerSelect').value,
        model: $('#modelName').value.trim(),
        key: $('#apiKey').value.trim(),
      };
      writeJSON(MODEL_KEY, model);
      updateModelDot();
      setModelStatus('Connection saved in this browser only.');
    });

    $('#forgetModel').addEventListener('click', () => {
      model = { provider: $('#providerSelect').value, model: '', key: '' };
      writeJSON(MODEL_KEY, model);
      $('#apiKey').value = '';
      $('#modelName').value = '';
      updateModelDot();
      setModelStatus('Key removed from this browser.');
    });

    $('#generateAI').addEventListener('click', generateWithAI);
  }

  function init() {
    if (!window.CFF) return;
    loadProfileIntoForm();
    loadModelIntoForm();
    bind();
    updateGrantMeta();
    updateWordCount();

    const f = fund();
    if (f) $('#draftStatus').textContent = `${f.name} · ${window.CFF.statusLabel(f)}`;
  }    document.addEventListener('DOMContentLoaded', init);
})();
