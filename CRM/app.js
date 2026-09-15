/* =====================================================================
   EASTERN UAV — OPERATIONS CRM
   easternuav.com/CRM/
   Static single-page app on Supabase. No build step, no server.
   The anon key below is public by design; row-level security in
   CRM-SCHEMA.sql is what actually protects the data.
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------- */
/* 1. CONFIG & STATE                                                 */
/* ---------------------------------------------------------------- */
const SUPABASE_URL  = 'https://yccxbftaopwbuyukjvzp.supabase.co';
const SUPABASE_ANON  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InljY3hiZnRhb3B3YnV5dWtqdnpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg3NDI3MjAsImV4cCI6MjEwNDMxODcyMH0.0UiSOt7aN7KdE0wpR963zVV-vHAs4wfE_iWS7sgd6sM';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

/* Bases the operation flies from. First Light / Last Light and the
   METAR lookup key off whichever base the user belongs to. */
const BASES = {
  'Kathmandu': { lat: 27.6966, lng: 85.3591, icao: 'VNKT', tz: 'Asia/Kathmandu' },
  'Pokhara'  : { lat: 28.2010, lng: 83.9820, icao: 'VNPR', tz: 'Asia/Kathmandu' },
  'Bharatpur': { lat: 27.6781, lng: 84.4294, icao: 'VNBP', tz: 'Asia/Kathmandu' },
  'Brisbane' : { lat: -27.3842, lng: 153.1175, icao: 'YBBN', tz: 'Australia/Brisbane' },
  'Caboolture':{ lat: -27.0744, lng: 152.9861, icao: 'YCAB', tz: 'Australia/Brisbane' }
};

const S = {
  booted: false,       // start() has settled; auth events are safe to act on
  session: null,
  me: null,            // crm_people row
  route: 'dashboard',
  cache: {},           // lightweight lookup caches
  wizard: null         // in-flight Create Job state
};

/* ---------------------------------------------------------------- */
/* 2. UTILITIES                                                      */
/* ---------------------------------------------------------------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const dash = v => (v === null || v === undefined || v === '') ? '<span class="muted">—</span>' : esc(v);

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'on ' + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = kind; }, 3400);
}

function fmtDate(d) {
  if (!d) return '';
  const x = new Date(d);
  if (isNaN(x)) return '';
  return x.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateTime(d) {
  if (!d) return '';
  const x = new Date(d);
  if (isNaN(x)) return '';
  return x.toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
  });
}
function forInput(d, withTime) {
  if (!d) return '';
  const x = new Date(d);
  if (isNaN(x)) return '';
  const p = n => String(n).padStart(2, '0');
  const base = `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  return withTime ? `${base}T${p(x.getHours())}:${p(x.getMinutes())}` : base;
}
const todayISO = () => forInput(new Date(), false);
function daysUntil(d) {
  if (!d) return null;
  const a = new Date(d); a.setHours(0, 0, 0, 0);
  const b = new Date();  b.setHours(0, 0, 0, 0);
  return Math.round((a - b) / 86400000);
}
const hrs = n => (Number(n) || 0).toFixed(2);
const initials = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

/* Risk matrix — rating is likelihood + consequence, 0..10 */
function riskBand(l, c) {
  if (l === null || l === undefined || c === null || c === undefined) return null;
  const r = Number(l) + Number(c);
  if (r >= 8) return { r, label: 'EXTREME', cls: 'm-ext',  pill: 'red' };
  if (r >= 6) return { r, label: 'HIGH',    cls: 'm-high', pill: 'amber' };
  if (r >= 4) return { r, label: 'MEDIUM',  cls: 'm-med',  pill: 'amber' };
  return       { r, label: 'LOW',     cls: 'm-low',  pill: 'green' };
}

const JOB_STATUS = {
  draft:     { label: 'Draft',     pill: 'grey'  },
  submitted: { label: 'Submitted', pill: 'blue'  },
  approved:  { label: 'Approved',  pill: 'green' },
  running:   { label: 'Running',   pill: 'blue'  },
  finished:  { label: 'Finished',  pill: 'grey'  },
  resubmit:  { label: 'Resubmit',  pill: 'red'   },
  rejected:  { label: 'Rejected',  pill: 'red'   }
};
const statusPill = s => {
  const m = JOB_STATUS[s] || { label: s, pill: 'grey' };
  return `<span class="pill ${m.pill}">${esc(m.label)}</span>`;
};

function modal(html, opts = {}) {
  const box = $('#modalbox');
  box.className = 'box' + (opts.wide ? ' wide' : '') + (opts.slim ? ' slim' : '');
  box.innerHTML = html;
  $('#modal').classList.add('on');
  const first = box.querySelector('input:not([type=hidden]),select,textarea');
  if (first && !opts.noFocus) setTimeout(() => first.focus(), 60);
}
function closeModal() { $('#modal').classList.remove('on'); $('#modalbox').innerHTML = ''; }

function confirmBox(title, body, okLabel = 'Confirm') {
  return new Promise(resolve => {
    modal(`
      <div class="mh"><h2>${esc(title)}</h2></div>
      <div class="mb"><p style="margin:0">${body}</p></div>
      <div class="mf">
        <button class="btn" data-x="no">Cancel</button>
        <button class="btn dang" data-x="yes">${esc(okLabel)}</button>
      </div>`, { slim: true, noFocus: true });
    $('#modalbox').onclick = e => {
      const b = e.target.closest('[data-x]');
      if (!b) return;
      closeModal();
      resolve(b.dataset.x === 'yes');
    };
  });
}

/* Read the form fields inside a container into a plain object */
function readForm(root) {
  const out = {};
  $$('[data-f]', root).forEach(el => {
    const k = el.dataset.f;
    if (el.type === 'checkbox') out[k] = el.checked;
    else if (el.type === 'number') out[k] = el.value === '' ? null : Number(el.value);
    else out[k] = el.value === '' ? null : el.value;
  });
  return out;
}

function csv(rows, filename) {
  const body = rows.map(r => r.map(c => {
    const v = c === null || c === undefined ? '' : String(c);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function q(promise, what) {
  const { data, error } = await promise;
  if (error) { console.error(what, error); toast(error.message || ('Could not load ' + what), 'bad'); return null; }
  return data;
}

/* ---------------------------------------------------------------- */
/* 3. SOLAR — first light / last light (civil twilight, -6°)         */
/* ---------------------------------------------------------------- */
function solarTimes(date, lat, lng) {
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const days = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
                           - Date.UTC(1970, 0, 1)) / 86400000);
  /* J2000 is anchored at noon, so the day count has to round up — floor
     here puts every event out by half a day. Checked against Brisbane
     15 Sep 2026: gives 05:22 / 18:03 against AVCRM's 05:25 / 18:04. */
  const n = Math.ceil(days - 10957.5 + 0.0008);
  const Jstar = n - lng / 360;
  const M = (357.5291 + 0.98560028 * Jstar) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.0200 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const L = (M + C + 180 + 102.9372) % 360;
  const Jtransit = 2451545.0 + Jstar + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * L * rad);
  const decl = Math.asin(Math.sin(L * rad) * Math.sin(23.44 * rad)) * deg;

  function eventFor(angle) {
    const cosH = (Math.sin(angle * rad) - Math.sin(lat * rad) * Math.sin(decl * rad)) /
                 (Math.cos(lat * rad) * Math.cos(decl * rad));
    if (cosH > 1 || cosH < -1) return null;          // never rises / never sets
    const H = Math.acos(cosH) * deg;
    const jset  = Jtransit + H / 360;
    const jrise = Jtransit - H / 360;
    const toDate = j => new Date((j - 2440587.5) * 86400000);
    return { rise: toDate(jrise), set: toDate(jset) };
  }
  const civil = eventFor(-6);
  const sun   = eventFor(-0.833);
  return {
    firstLight: civil ? civil.rise : null,
    lastLight : civil ? civil.set  : null,
    sunrise   : sun   ? sun.rise   : null,
    sunset    : sun   ? sun.set    : null
  };
}
/* Always render in the base's own timezone — a Brisbane-based manager
   checking the Kathmandu operation wants Kathmandu's clock, not theirs. */
const hhmm = (d, tz) => d
  ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz || undefined })
  : '--:--';

/* ---------------------------------------------------------------- */
/* 4. AUTH                                                           */
/* ---------------------------------------------------------------- */
let loginMode = 'in';   // in | up | reset

function paintLogin() {
  const t = $('#lg-title'), s = $('#lg-sub'), go = $('#lg-go'),
        tog = $('#lg-toggle'), nameF = $('#lg-name-f'), passF = $('#lg-pass-f');
  if (loginMode === 'in') {
    t.textContent = 'Welcome back';
    s.textContent = 'Use the same login as the student portal.';
    go.textContent = 'Sign in'; tog.textContent = 'Create an account';
    nameF.hidden = true; passF.hidden = false; $('#lg-pass').required = true;
  } else if (loginMode === 'up') {
    t.textContent = 'Create your account';
    s.textContent = 'You will be able to sign in, but an administrator has to grant you access before you see anything.';
    go.textContent = 'Create account'; tog.textContent = 'I already have an account';
    nameF.hidden = false; passF.hidden = false; $('#lg-pass').required = true;
  } else {
    t.textContent = 'Reset your password';
    s.textContent = 'We will email you a link to set a new one.';
    go.textContent = 'Send reset link'; tog.textContent = 'Back to sign in';
    nameF.hidden = true; passF.hidden = true; $('#lg-pass').required = false;
  }
  $('#lg-msg').textContent = '';
}

function wireLogin() {
  $('#lg-toggle').onclick = () => { loginMode = loginMode === 'in' ? 'up' : 'in'; paintLogin(); };
  $('#lg-reset').onclick  = () => { loginMode = loginMode === 'reset' ? 'in' : 'reset'; paintLogin(); };

  $('#lg-form').onsubmit = async e => {
    e.preventDefault();
    const email = $('#lg-email').value.trim();
    const pass  = $('#lg-pass').value;
    const msg   = $('#lg-msg');
    const go    = $('#lg-go');
    go.disabled = true;
    msg.style.color = 'var(--muted)';
    msg.textContent = 'Working…';

    try {
      if (loginMode === 'reset') {
        const { error } = await sb.auth.resetPasswordForEmail(email, {
          redirectTo: location.origin + '/CRM/'
        });
        if (error) throw error;
        msg.style.color = 'var(--green)';
        msg.textContent = 'Check your inbox for the reset link.';
      } else if (loginMode === 'up') {
        const { error } = await sb.auth.signUp({
          email, password: pass,
          options: { data: { full_name: $('#lg-name').value.trim() }, emailRedirectTo: location.origin + '/CRM/' }
        });
        if (error) throw error;
        msg.style.color = 'var(--green)';
        msg.textContent = 'Account created. Confirm your email, then sign in.';
        loginMode = 'in';
        setTimeout(paintLogin, 2600);
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password: pass });
        if (error) throw error;
        msg.textContent = '';
        /* onAuthStateChange takes it from here */
      }
    } catch (err) {
      msg.style.color = 'var(--red)';
      msg.textContent = err.message || 'That did not work.';
    } finally {
      go.disabled = false;
    }
  };
}

async function loadMe() {
  const uid = S.session.user.id;
  let { data, error } = await sb.from('crm_people').select('*').eq('id', uid).maybeSingle();
  if (error) {
    console.error('crm_people select', error);
    /* A missing table is the common case and deserves plain words. */
    if (/relation .* does not exist|schema cache/i.test(error.message || '')) {
      throw new Error('The CRM tables are not in the database yet. Run CRM-SCHEMA.sql in the Supabase SQL editor, then reload.');
    }
    throw new Error(error.message);
  }
  if (!data) {
    /* The database trigger normally makes this row. If the user
       predates the trigger, make it now. */
    const ins = await sb.from('crm_people').insert({
      id: uid,
      full_name: S.session.user.user_metadata?.full_name || S.session.user.email.split('@')[0],
      email: S.session.user.email
    }).select().maybeSingle();
    if (ins.error) {
      console.error('crm_people insert', ins.error);
      throw new Error('Signed in, but no CRM record exists for this account and one could not be created: ' + ins.error.message);
    }
    data = ins.data;
  }
  S.me = data;
  return data;
}

/* ---------------------------------------------------------------- */
/* 5. NAVIGATION & ROUTER                                            */
/* ---------------------------------------------------------------- */
const IC = {
  dash:  '<path d="M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z"/>',
  jobs:  '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  log:   '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  qual:  '<path d="M12 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm-4 1.5V23l4-2 4 2v-6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  fleet: '<path d="M12 2 2 12h4v9h5v-6h2v6h5v-9h4L12 2Z"/>',
  maint: '<path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 1 5.4-5.4l-2.5 2.5 2.1 2.1 2.5-2.5a4 4 0 0 1-5.1-5.1Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  sms:   '<path d="M12 2 2 20h20L12 2Zm0 6v6m0 3v.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  docs:  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  ppl:   '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm14 10v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  risk:  '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  me:    '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
};
const icon = k => `<svg class="ic" viewBox="0 0 24 24" fill="currentColor">${IC[k] || ''}</svg>`;

/* route -> {title, sub, icon, group, roles, render} */
const ROUTES = {};
function route(key, def) { ROUTES[key] = def; }

function allowed(def) {
  if (!def.roles) return true;
  return def.roles.includes(S.me?.role);
}

function buildNav() {
  const groups = {};
  Object.entries(ROUTES).forEach(([k, d]) => {
    if (d.hidden || !allowed(d)) return;
    (groups[d.group] = groups[d.group] || []).push([k, d]);
  });
  $('#nav').innerHTML = Object.entries(groups).map(([g, items]) => `
    <div class="navgrp">${esc(g)}</div>
    ${items.map(([k, d]) => `
      <button class="navlink" data-go="${k}">
        ${icon(d.icon)}<span>${esc(d.nav || d.title)}</span>
        <span class="count" data-count="${k}" hidden></span>
      </button>`).join('')}
  `).join('');
}

function setCount(key, n) {
  const el = $(`[data-count="${key}"]`);
  if (!el) return;
  if (n > 0) { el.textContent = n; el.hidden = false; } else { el.hidden = true; }
}

async function go(key, param) {
  const def = ROUTES[key];
  if (!def || !allowed(def)) { key = 'dashboard'; }
  S.route = key;
  const d = ROUTES[key];
  $('#pg-title').textContent = d.title;
  $('#pg-sub').textContent   = typeof d.sub === 'function' ? d.sub() : (d.sub || '');
  $$('.navlink').forEach(b => b.classList.toggle('on', b.dataset.go === key));
  $('#sidebar').classList.remove('open');
  $('#scrim').classList.remove('on');
  const c = $('#content');
  c.innerHTML = `<div class="empty"><div class="spin" style="width:24px;height:24px;border:3px solid var(--line);border-top-color:var(--crimson);border-radius:50%;margin:0 auto;animation:spin .8s linear infinite"></div></div>`;
  window.scrollTo(0, 0);
  if (location.hash.slice(1).split('/')[0] !== key) {
    history.replaceState(null, '', '#' + key + (param ? '/' + param : ''));
  }
  try { await d.render(c, param); }
  catch (err) { console.error(err); c.innerHTML = `<div class="card"><div class="bd empty"><b>Something broke on this screen</b><p>${esc(err.message)}</p></div></div>`; }
}

/* ---------------------------------------------------------------- */
/* 6. SHARED LOOKUPS                                                 */
/* ---------------------------------------------------------------- */
async function people(force) {
  if (!S.cache.people || force)
    S.cache.people = await q(sb.from('crm_people').select('id,full_name,role,email,base,is_active').order('full_name'), 'people') || [];
  return S.cache.people;
}
async function aircraft(force) {
  if (!S.cache.aircraft || force)
    S.cache.aircraft = await q(sb.from('crm_aircraft').select('*').order('identifier'), 'aircraft') || [];
  return S.cache.aircraft;
}
async function clients(force) {
  if (!S.cache.clients || force)
    S.cache.clients = await q(sb.from('crm_clients').select('*').eq('is_active', true).order('name'), 'clients') || [];
  return S.cache.clients;
}
const nameOf = (list, id) => (list.find(x => x.id === id) || {}).full_name || '';
const acOf   = (list, id) => (list.find(x => x.id === id) || {}).identifier || '';

function options(list, valueKey, labelKey, selected, placeholder) {
  return (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') +
    list.map(o => `<option value="${esc(o[valueKey])}"${String(o[valueKey]) === String(selected) ? ' selected' : ''}>${esc(o[labelKey])}</option>`).join('');
}

/* ================================================================== */
/*  VIEWS                                                             */
/* ================================================================== */

/* ---------------------------------------------------------------- */
/* DASHBOARD                                                         */
/* ---------------------------------------------------------------- */
route('dashboard', {
  title: 'Dashboard', group: 'Overview', icon: 'dash',
  sub: () => `Eastern UAV — ${S.me?.base || 'Kathmandu'}`,
  render: async (c) => {
    const base = BASES[S.me?.base] || BASES['Kathmandu'];
    const sun  = solarTimes(new Date(), base.lat, base.lng);
    const admin = ['super_admin', 'instructor'].includes(S.me.role);

    const [jobs, flights, quals, defects, notices, P] = await Promise.all([
      q(sb.from('crm_jobs').select('id,job_no,job_type,name,status,job_date,location_name,created_by').order('job_date', { ascending: false }).limit(200), 'jobs'),
      q(sb.from('crm_flights').select('flight_hours,flight_date,person_id').eq('person_id', S.me.id), 'flights'),
      q(sb.from('crm_qualifications').select('id,person_id,title,qual_type,expires_on').not('expires_on', 'is', null).order('expires_on'), 'qualifications'),
      q(sb.from('crm_defects').select('id,status,severity,description,aircraft_id,reported_on').neq('status', 'closed').order('reported_on', { ascending: false }), 'defects'),
      q(sb.from('crm_notices').select('*').order('created_at', { ascending: false }).limit(4), 'notices'),
      people()
    ]);

    const J = jobs || [], F = flights || [], Q = quals || [], D = defects || [], N = notices || [];
    const pending  = J.filter(j => j.status === 'submitted').length;
    const approved = J.filter(j => j.status === 'approved').length;
    const running  = J.filter(j => j.status === 'running').length;
    const totalHrs = F.reduce((a, b) => a + Number(b.flight_hours || 0), 0);
    const last90   = F.filter(f => daysUntil(f.flight_date) >= -90).reduce((a, b) => a + Number(b.flight_hours || 0), 0);
    const expiring = Q.filter(x => { const d = daysUntil(x.expires_on); return d !== null && d <= 60; });
    const expired  = expiring.filter(x => daysUntil(x.expires_on) < 0);

    setCount('jobs', pending);
    setCount('defects', D.length);

    const mine = J.filter(j => j.created_by === S.me.id || admin).slice(0, 8);

    c.innerHTML = `
      <div class="tiles">
        <div class="tile link" data-go="jobs">
          <div class="lbl">Awaiting approval</div><div class="val">${pending}</div>
          <div class="sub">${approved} approved · ${running} running</div>
        </div>
        <div class="tile green link" data-go="flights">
          <div class="lbl">Your flight hours</div><div class="val">${hrs(totalHrs)}</div>
          <div class="sub">${hrs(last90)} in the last 90 days</div>
        </div>
        <div class="tile ${expired.length ? 'red' : expiring.length ? 'amber' : 'green'} link" data-go="quals">
          <div class="lbl">Currency</div><div class="val">${expiring.length}</div>
          <div class="sub">${expired.length ? expired.length + ' already expired' : 'expiring within 60 days'}</div>
        </div>
        <div class="tile ${D.length ? 'red' : 'green'} link" data-go="defects">
          <div class="lbl">Open defects</div><div class="val">${D.length}</div>
          <div class="sub">${D.filter(d => d.severity === 'grounding').length} grounding</div>
        </div>
        <div class="tile amber">
          <div class="lbl">First / last light</div>
          <div class="val" style="font-size:20px">${hhmm(sun.firstLight, base.tz)} – ${hhmm(sun.lastLight, base.tz)}</div>
          <div class="sub">${esc(S.me?.base || 'Kathmandu')} · ${esc(base.icao)}</div>
        </div>
      </div>

      ${expiring.length ? `
      <div class="card" style="margin-bottom:16px;border-left:3px solid var(--${expired.length ? 'red' : 'amber'})">
        <div class="hd"><h3>Currency needing attention</h3><button class="btn sm" data-go="quals">Open register</button></div>
        <div class="bd tight">
          ${expiring.slice(0, 5).map(x => {
            const d = daysUntil(x.expires_on);
            return `<div class="listitem between">
              <div><b>${esc(x.title)}</b> <span class="pill grey">${esc(x.qual_type)}</span>
                <div class="tiny muted">${admin && nameOf(P, x.person_id) ? esc(nameOf(P, x.person_id)) + ' · ' : ''}expires ${fmtDate(x.expires_on)}</div></div>
              <span class="pill ${d < 0 ? 'red' : d <= 30 ? 'amber' : 'grey'}">${d < 0 ? `${-d} days overdue` : `${d} days`}</span>
            </div>`; }).join('')}
        </div>
      </div>` : ''}

      <div class="grid2">
        <div class="card">
          <div class="hd">
            <h3>${admin ? 'Recent jobs' : 'Your recent jobs'}</h3>
            <button class="btn pri sm" data-newjob>New job</button>
            <button class="btn sm" data-go="jobs">See all</button>
          </div>
          <div class="bd tight">
            ${mine.length ? `<div class="tblwrap"><table class="tbl">
              <thead><tr><th>Job #</th><th>Name</th><th>Date</th><th>Location</th><th>Status</th></tr></thead>
              <tbody>${mine.map(j => `
                <tr style="cursor:pointer" data-job="${j.id}">
                  <td class="mono nowrap">${String(j.job_no).padStart(6, '0')} <span class="tag ${esc(j.job_type)}">${esc(j.job_type)}</span></td>
                  <td>${esc(j.name)}</td>
                  <td class="nowrap">${fmtDateTime(j.job_date)}</td>
                  <td>${dash(j.location_name)}</td>
                  <td>${statusPill(j.status)}</td>
                </tr>`).join('')}</tbody></table></div>`
              : `<div class="empty"><b>No jobs yet</b><p>Every flight starts with a job. Raise one, work through the risk assessment and JSA, and sign it off.</p><button class="btn pri" data-newjob>Create the first job</button></div>`}
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <div class="hd"><h3>Notices</h3></div>
            <div class="bd tight">
              ${N.length ? N.map(n => `
                <div class="listitem">
                  <div class="between" style="align-items:flex-start">
                    <b>${esc(n.title)}</b>
                    ${n.urgency !== 'normal' ? `<span class="pill ${n.urgency === 'urgent' ? 'red' : 'amber'}">${esc(n.urgency)}</span>` : ''}
                  </div>
                  <div class="tiny muted" style="margin-top:2px">${fmtDate(n.created_at)}</div>
                  ${n.body ? `<p style="margin:6px 0 0;font-size:13px">${esc(n.body)}</p>` : ''}
                </div>`).join('')
                : '<div class="empty tiny">Nothing posted.</div>'}
            </div>
          </div>

          <div class="card">
            <div class="hd"><h3>Conditions</h3><span class="tiny muted">${esc(base.icao)}</span></div>
            <div class="bd">
              <dl class="kv">
                <dt>First light</dt><dd>${hhmm(sun.firstLight, base.tz)}</dd>
                <dt>Sunrise</dt><dd>${hhmm(sun.sunrise, base.tz)}</dd>
                <dt>Sunset</dt><dd>${hhmm(sun.sunset, base.tz)}</dd>
                <dt>Last light</dt><dd>${hhmm(sun.lastLight, base.tz)}</dd>
              </dl>
              <div class="divider"></div>
              <div class="tiny muted" style="margin-bottom:5px">Latest METAR</div>
              <div class="mono" id="metar" style="font-size:12px;word-break:break-word;color:var(--ink)">loading…</div>
            </div>
          </div>
        </div>
      </div>`;

    /* METAR is best-effort: no key, and it fails quietly offline. */
    fetch(`https://aviationweather.gov/api/data/metar?ids=${base.icao}&format=raw`)
      .then(r => r.ok ? r.text() : Promise.reject())
      .then(t => { $('#metar') && ($('#metar').textContent = (t || '').trim() || 'No report available.'); })
      .catch(() => { $('#metar') && ($('#metar').textContent = 'Unavailable — check the official source before flight.'); });
  }
});

/* ---------------------------------------------------------------- */
/* JOB MANAGER                                                       */
/* ---------------------------------------------------------------- */
route('jobs', {
  title: 'Job Manager', group: 'Operations', icon: 'jobs',
  sub: 'Raise, approve, run and close out flight jobs',
  render: async (c, param) => {
    if (param) return jobDetail(c, param);
    const admin = ['super_admin', 'instructor'].includes(S.me.role);
    const [J, P, A, CL] = await Promise.all([
      q(sb.from('crm_jobs').select('*').order('job_date', { ascending: false }).limit(400), 'jobs'),
      people(), aircraft(), clients()
    ]);
    const jobs = J || [];
    setCount('jobs', jobs.filter(j => j.status === 'submitted').length);

    c.innerHTML = `
      <div class="searchbar">
        <input class="inp" id="jf-q" placeholder="Search job name, number or location…">
        <select class="inp" id="jf-status">
          <option value="">All statuses</option>
          ${Object.entries(JOB_STATUS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
        </select>
        <select class="inp" id="jf-type">
          <option value="">All types</option>
          <option value="TRA">TRA — Training</option>
          <option value="OPS">OPS — Operational</option>
          <option value="PROF">PROF — Proficiency</option>
        </select>
        <button class="btn" id="jf-export">Export CSV</button>
        <button class="btn pri" data-newjob>New job</button>
      </div>
      <div class="card"><div class="bd tight"><div class="tblwrap">
        <table class="tbl">
          <thead><tr>
            <th>Job #</th><th>Status</th><th>Job name</th><th>RPA</th><th>Crew</th>
            <th>Date</th><th>Location</th><th>Client</th><th></th>
          </tr></thead>
          <tbody id="jbody"></tbody>
        </table>
      </div></div></div>`;

    /* crew + aircraft in one hit each, then stitch */
    const [jp, ja] = await Promise.all([
      q(sb.from('crm_job_pilots').select('job_id,person_id,crew_role'), 'crew'),
      q(sb.from('crm_job_aircraft').select('job_id,aircraft_id'), 'job aircraft')
    ]);
    const crewBy = {}, acBy = {};
    (jp || []).forEach(r => (crewBy[r.job_id] = crewBy[r.job_id] || []).push(nameOf(P, r.person_id)));
    (ja || []).forEach(r => (acBy[r.job_id] = acBy[r.job_id] || []).push(acOf(A, r.aircraft_id)));

    function paint() {
      const term = $('#jf-q').value.trim().toLowerCase();
      const st = $('#jf-status').value, ty = $('#jf-type').value;
      const rows = jobs.filter(j =>
        (!st || j.status === st) && (!ty || j.job_type === ty) &&
        (!term || (j.name || '').toLowerCase().includes(term) ||
                  String(j.job_no).includes(term) ||
                  (j.location_name || '').toLowerCase().includes(term)));

      $('#jbody').innerHTML = rows.length ? rows.map(j => {
        const canAct = admin || j.created_by === S.me.id;
        let act = '';
        if (canAct) {
          if (j.status === 'approved') act = `<button class="btn ok sm" data-act="start" data-id="${j.id}">Start</button>`;
          else if (j.status === 'running') act = `<button class="btn dang sm" data-act="finish" data-id="${j.id}">Finish</button>`;
          else if (j.status === 'submitted' && admin) act = `<button class="btn ok sm" data-act="approve" data-id="${j.id}">Approve</button>`;
          else if (['draft', 'resubmit'].includes(j.status) && j.created_by === S.me.id)
            act = `<button class="btn sm" data-act="submit" data-id="${j.id}">Submit</button>`;
        }
        return `<tr>
          <td class="mono nowrap" style="cursor:pointer" data-job="${j.id}">
            ${String(j.job_no).padStart(6, '0')} <span class="tag ${esc(j.job_type)}">${esc(j.job_type)}</span></td>
          <td>${statusPill(j.status)}</td>
          <td style="cursor:pointer" data-job="${j.id}"><b>${esc(j.name)}</b></td>
          <td class="tiny">${dash((acBy[j.id] || []).join(', '))}</td>
          <td class="tiny">${dash((crewBy[j.id] || []).join(', '))}</td>
          <td class="nowrap tiny">${fmtDateTime(j.job_date)}</td>
          <td class="tiny">${dash(j.location_name)}</td>
          <td class="tiny">${dash((CL.find(x => x.id === j.client_id) || {}).name)}</td>
          <td class="nowrap"><div class="actions">${act}
            <button class="btn sm" data-job="${j.id}">Open</button></div></td>
        </tr>`;
      }).join('') : `<tr><td colspan="9"><div class="empty"><b>No jobs match</b><p>Try clearing the filters.</p></div></td></tr>`;
    }
    paint();
    $('#jf-q').oninput = paint; $('#jf-status').onchange = paint; $('#jf-type').onchange = paint;
    $('#jf-export').onclick = () => csv(
      [['Job #', 'Type', 'Status', 'Name', 'Date', 'Location', 'RPA', 'Crew', 'Client']].concat(
        jobs.map(j => [String(j.job_no).padStart(6, '0'), j.job_type, j.status, j.name,
          fmtDateTime(j.job_date), j.location_name, (acBy[j.id] || []).join(' / '),
          (crewBy[j.id] || []).join(' / '), (CL.find(x => x.id === j.client_id) || {}).name])),
      `eastern-uav-jobs-${todayISO()}.csv`);
  }
});

async function jobAction(id, act) {
  const now = new Date().toISOString();
  const patch =
    act === 'submit'  ? { status: 'submitted', submitted_at: now } :
    act === 'approve' ? { status: 'approved', approved_by: S.me.id, approved_at: now } :
    act === 'start'   ? { status: 'running', started_at: now } :
    act === 'finish'  ? { status: 'finished', finished_at: now } : null;
  if (!patch) return;
  const { error } = await sb.from('crm_jobs').update(patch).eq('id', id);
  if (error) return toast(error.message, 'bad');
  toast(act === 'finish' ? 'Job finished — log the flight time.' : 'Job ' + patch.status, 'good');
  if (act === 'finish') return go('jobs', id);
  go('jobs');
}

/* ---- Job detail -------------------------------------------------- */
async function jobDetail(c, id) {
  const [job, P, A, CL] = await Promise.all([
    q(sb.from('crm_jobs').select('*').eq('id', id).maybeSingle(), 'job'),
    people(), aircraft(), clients()
  ]);
  if (!job) { c.innerHTML = `<div class="card"><div class="bd empty"><b>Job not found</b><p>It may have been deleted, or you may not have access to it.</p><button class="btn" data-go="jobs">Back to Job Manager</button></div></div>`; return; }

  const [crew, jac, jsa, areas, ra, ris, fl] = await Promise.all([
    q(sb.from('crm_job_pilots').select('*').eq('job_id', id), 'crew'),
    q(sb.from('crm_job_aircraft').select('*').eq('job_id', id), 'aircraft'),
    q(sb.from('crm_job_jsa').select('*').eq('job_id', id).order('sort_order'), 'jsa'),
    q(sb.from('crm_job_areas').select('*').eq('job_id', id), 'areas'),
    job.risk_assessment_id ? q(sb.from('crm_risk_assessments').select('*').eq('id', job.risk_assessment_id).maybeSingle(), 'risk') : Promise.resolve(null),
    job.risk_assessment_id ? q(sb.from('crm_risk_items').select('*').eq('assessment_id', job.risk_assessment_id).order('step_no'), 'risk items') : Promise.resolve([]),
    q(sb.from('crm_flights').select('*').eq('job_id', id), 'flights')
  ]);

  const admin = ['super_admin', 'instructor'].includes(S.me.role);
  const mine  = job.created_by === S.me.id;
  const jsaDone = (jsa || []).filter(x => x.checked).length;

  c.innerHTML = `
    <div class="between" style="margin-bottom:14px">
      <div>
        <div class="between" style="gap:9px;justify-content:flex-start">
          <h1 style="font-size:22px">${esc(job.name)}</h1>
          <span class="tag ${esc(job.job_type)}">${esc(job.job_type)}</span>
          ${statusPill(job.status)}
        </div>
        <div class="tiny muted" style="margin-top:3px">Job #${String(job.job_no).padStart(6, '0')} · raised ${fmtDate(job.created_at)} by ${esc(nameOf(P, job.created_by) || '—')}</div>
      </div>
      <div class="actions">
        <button class="btn" data-go="jobs">Back</button>
        ${(admin || mine) && ['draft', 'resubmit'].includes(job.status) ? `<button class="btn" data-editjob="${job.id}">Edit</button>` : ''}
        ${(admin || mine) && ['draft', 'resubmit'].includes(job.status) ? `<button class="btn nav" data-act="submit" data-id="${job.id}">Submit for approval</button>` : ''}
        ${admin && job.status === 'submitted' ? `<button class="btn ok" data-act="approve" data-id="${job.id}">Approve</button>
          <button class="btn dang" data-act="sendback" data-id="${job.id}">Send back</button>` : ''}
        ${(admin || mine) && job.status === 'approved' ? `<button class="btn ok" data-act="start" data-id="${job.id}">Start</button>` : ''}
        ${(admin || mine) && job.status === 'running' ? `<button class="btn dang" data-act="finish" data-id="${job.id}">Finish</button>` : ''}
        <button class="btn" data-print>Print / PDF</button>
      </div>
    </div>

    ${job.review_note ? `<div class="card" style="margin-bottom:14px;border-left:3px solid var(--red)"><div class="bd">
      <b style="color:var(--red)">Sent back for revision</b><p style="margin:5px 0 0">${esc(job.review_note)}</p></div></div>` : ''}

    <div class="grid2">
      <div class="stack">
        <div class="card"><div class="hd"><h3>Details</h3></div><div class="bd">
          <dl class="kv">
            <dt>Job date</dt><dd>${fmtDateTime(job.job_date) || '—'}</dd>
            <dt>Estimated finish</dt><dd>${fmtDateTime(job.est_finish) || '—'}</dd>
            <dt>Multi-day</dt><dd>${job.multiday ? 'Yes' : 'No'}</dd>
            <dt>Client</dt><dd>${dash((CL.find(x => x.id === job.client_id) || {}).name)}</dd>
            <dt>Internal reference</dt><dd>${dash(job.internal_ref)}</dd>
            <dt>RPA</dt><dd>${dash((jac || []).map(r => acOf(A, r.aircraft_id)).join(', '))}</dd>
            <dt>Crew</dt><dd>${(crew || []).length ? (crew || []).map(r => `${esc(nameOf(P, r.person_id))} <span class="pill grey">${esc(r.crew_role)}</span>`).join('<br>') : '<span class="muted">—</span>'}</dd>
            <dt>Location</dt><dd>${dash(job.location_name)}${job.lat ? ` <span class="tiny muted mono">(${job.lat}, ${job.lng})</span>` : ''}</dd>
            <dt>Tethered</dt><dd>${job.tethered ? 'Yes' : 'No'}</dd>
            <dt>Max job height</dt><dd>${esc(job.max_height_ft || 400)} ft AGL</dd>
            <dt>CASA / CAAN approval</dt><dd>${dash(job.casa_approval)}</dd>
            <dt>Maps &amp; charts</dt><dd>${job.maps_checked ? '<span class="pill green">Checked</span>' : '<span class="pill red">Not checked</span>'}</dd>
            <dt>Job details</dt><dd>${dash(job.details)}</dd>
            <dt>Emergency contacts</dt><dd>${dash(job.emergency_contacts)}</dd>
          </dl>
        </div></div>

        <div class="card"><div class="hd"><h3>JSA</h3>
          <span class="pill ${jsaDone === (jsa || []).length && jsaDone > 0 ? 'green' : 'amber'}">${jsaDone} of ${(jsa || []).length} checked</span></div>
          <div class="bd tight">
            ${(jsa || []).length ? (jsa || []).map(x => `
              <div class="listitem between" style="align-items:flex-start;gap:12px">
                <div><b style="font-weight:550">${esc(x.item_label)}</b>
                  ${x.comment ? `<div class="tiny muted" style="margin-top:2px">${esc(x.comment)}</div>` : ''}</div>
                <span class="pill ${x.checked ? 'green' : 'grey'}">${x.checked ? 'Checked' : 'Not checked'}</span>
              </div>`).join('') : '<div class="empty tiny">No JSA recorded.</div>'}
          </div>
        </div>

        ${ra ? `<div class="card"><div class="hd"><h3>Risk assessment</h3>
          <span class="tiny muted">${esc(ra.title)} · v${ra.version}</span></div>
          <div class="bd tight"><div class="tblwrap"><table class="tbl" style="min-width:760px">
            <thead><tr><th>#</th><th>Hazard</th><th>Existing controls</th><th>Initial</th>
              <th>Additional controls</th><th>Residual</th></tr></thead>
            <tbody>${(ris || []).map(r => {
              const a = riskBand(r.l_initial, r.c_initial), b = riskBand(r.l_final, r.c_final);
              return `<tr>
                <td class="mono">${String(r.step_no).padStart(3, '0')}</td>
                <td><b>${esc(r.title)}</b>${r.the_risk ? `<div class="tiny muted">${esc(r.the_risk)}</div>` : ''}</td>
                <td class="tiny">${dash(r.existing_controls)}</td>
                <td>${a ? `<span class="pill ${a.pill}">${a.r} ${a.label}</span>` : '—'}</td>
                <td class="tiny">${dash(r.additional_controls)}</td>
                <td>${b ? `<span class="pill ${b.pill}">${b.r} ${b.label}</span>` : '—'}</td>
              </tr>`; }).join('')}</tbody>
          </table></div></div></div>` : ''}
      </div>

      <div class="stack">
        <div class="card"><div class="hd"><h3>Sign off</h3></div><div class="bd">
          ${job.signature
            ? `<img src="${esc(job.signature)}" alt="signature" style="background:#fcfcf4;border:1px solid var(--line);border-radius:8px;width:100%">
               <div class="tiny muted" style="margin-top:7px">${esc(nameOf(P, job.signed_by))} · ${fmtDateTime(job.signed_at)}</div>`
            : `<div class="empty tiny" style="padding:20px 0"><b>Not signed</b><p>The pilot in command signs the job before flight.</p>
               ${(admin || mine) ? `<button class="btn pri sm" data-sign="${job.id}">Sign now</button>` : ''}</div>`}
          ${job.approved_at ? `<div class="divider"></div><dl class="kv"><dt>Approved by</dt><dd>${esc(nameOf(P, job.approved_by))}</dd><dt>Approved</dt><dd>${fmtDateTime(job.approved_at)}</dd></dl>` : ''}
        </div></div>

        <div class="card"><div class="hd"><h3>Job areas</h3></div><div class="bd tight">
          ${(areas || []).length ? (areas || []).map(a => `
            <div class="listitem">
              <b>${esc(a.label || a.area_type.replace(/_/g, ' '))}</b>
              <div class="tiny muted mono">${a.lat ?? '—'}, ${a.lng ?? '—'} · up to ${esc(a.ceiling_ft || 400)} ft AGL</div>
              ${a.airspace ? `<div class="tiny">Airspace: ${esc(a.airspace)}${a.radio_freq ? ' · ' + esc(a.radio_freq) : ''}</div>` : ''}
            </div>`).join('') : '<div class="empty tiny">No areas recorded.</div>'}
        </div></div>

        <div class="card"><div class="hd"><h3>Flight time</h3>
          ${['running', 'finished'].includes(job.status) && (admin || mine)
            ? `<button class="btn pri sm" data-logflight="${job.id}">Log flight</button>` : ''}</div>
          <div class="bd tight">
            ${(fl || []).length ? (fl || []).map(f => `
              <div class="listitem between">
                <div><b>${esc(acOf(A, f.aircraft_id) || 'Aircraft')}</b>
                  <div class="tiny muted">${esc(nameOf(P, f.person_id))} · ${fmtDate(f.flight_date)}</div></div>
                <b class="mono">${hrs(f.flight_hours)} h</b>
              </div>`).join('') : '<div class="empty tiny">No flight time logged.</div>'}
          </div>
        </div>

        <div class="card"><div class="hd"><h3>Attachments</h3></div><div class="bd tight">
          ${(job.attachments || []).length ? (job.attachments || []).map(a =>
            `<div class="listitem"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title || a.url)}</a></div>`).join('')
            : '<div class="empty tiny">None.</div>'}
        </div></div>
      </div>
    </div>`;

  $('[data-print]') && ($('[data-print]').onclick = () => window.print());
}

/* ---- Create / edit job wizard ------------------------------------ */
const WSTEPS = ['Details', 'Job Area', 'Risk', 'JSA', 'Attachments', 'Sign Off'];

async function jobWizard(existingId) {
  const [P, A, CL, TPL, RAS] = await Promise.all([
    people(), aircraft(), clients(),
    q(sb.from('crm_jsa_template').select('*').order('sort_order'), 'JSA template'),
    q(sb.from('crm_risk_assessments').select('id,title,applicability,version').order('created_at', { ascending: false }), 'risk library')
  ]);

  let job = { job_type: 'TRA', max_height_ft: 400, multiday: false, tethered: false,
              maps_checked: false, ext_risk_done: false, casa_approval: 'Not Required',
              job_date: forInput(new Date(), true) };
  let crew = [], acs = [], jsa = (TPL || []).map(t => ({ ...t, checked: false, comment: '' })), areas = [], sig = null;

  if (existingId) {
    const [j, jp, ja, js, ar] = await Promise.all([
      q(sb.from('crm_jobs').select('*').eq('id', existingId).maybeSingle(), 'job'),
      q(sb.from('crm_job_pilots').select('*').eq('job_id', existingId), 'crew'),
      q(sb.from('crm_job_aircraft').select('*').eq('job_id', existingId), 'ac'),
      q(sb.from('crm_job_jsa').select('*').eq('job_id', existingId).order('sort_order'), 'jsa'),
      q(sb.from('crm_job_areas').select('*').eq('job_id', existingId), 'areas')
    ]);
    if (!j) return toast('Job not found', 'bad');
    job = { ...j, job_date: forInput(j.job_date, true), est_finish: forInput(j.est_finish, true) };
    crew = (jp || []).map(r => ({ person_id: r.person_id, crew_role: r.crew_role }));
    acs  = (ja || []).map(r => r.aircraft_id);
    if ((js || []).length) jsa = js;
    areas = ar || [];
    sig = j.signature;
  }

  let step = 0;

  function render() {
    modal(`
      <div class="mh">
        <h2>${existingId ? 'Edit job' : 'Create job'}</h2>
        <button class="x" data-close>&times;</button>
      </div>
      <div class="steps">${WSTEPS.map((s, i) =>
        `<div class="step ${i === step ? 'on' : ''} ${i < step ? 'done' : ''}" data-step="${i}">
           <div class="n">Step ${i + 1}</div><div class="t">${s}</div></div>`).join('')}</div>
      <div class="mb" id="wbody"></div>
      <div class="mf">
        <button class="btn ghost" data-close>Cancel</button>
        <div style="flex:1"></div>
        ${step > 0 ? '<button class="btn" data-prev>&larr; Previous</button>' : ''}
        <button class="btn" data-save>Save draft</button>
        ${step < WSTEPS.length - 1
          ? '<button class="btn nav" data-next>Save &amp; proceed &rarr;</button>'
          : '<button class="btn pri" data-finish>Save &amp; close</button>'}
      </div>`, { wide: true, noFocus: true });
    paintStep();
  }

  function paintStep() {
    const b = $('#wbody');
    if (step === 0) {
      b.innerHTML = `
        <div class="row c3">
          <div class="field"><label>Job type</label>
            <select class="inp" data-f="job_type">
              <option value="TRA"${job.job_type === 'TRA' ? ' selected' : ''}>TRA — Training</option>
              <option value="OPS"${job.job_type === 'OPS' ? ' selected' : ''}>OPS — Operational</option>
              <option value="PROF"${job.job_type === 'PROF' ? ' selected' : ''}>PROF — Proficiency</option>
            </select></div>
          <div class="field" style="grid-column:span 2"><label>Job name</label>
            <input class="inp" data-f="name" value="${esc(job.name || '')}" placeholder="e.g. Pokhrel Sub-25kg 15 Sept"></div>
        </div>
        <div class="row c2">
          <div class="field"><label>Job date &amp; start</label>
            <input class="inp" type="datetime-local" data-f="job_date" value="${esc(job.job_date || '')}"></div>
          <div class="field"><label>Estimated finish</label>
            <input class="inp" type="datetime-local" data-f="est_finish" value="${esc(job.est_finish || '')}"></div>
        </div>
        <div class="row c2">
          <div class="field"><label>Client</label>
            <select class="inp" data-f="client_id">${options(CL, 'id', 'name', job.client_id, '— none —')}</select></div>
          <div class="field"><label>Internal job reference</label>
            <input class="inp" data-f="internal_ref" value="${esc(job.internal_ref || '')}"></div>
        </div>
        <div class="field"><label>Aircraft (RPA)</label>
          <div class="row c3" style="gap:4px 13px">
            ${A.map(a => `<label class="chk"><input type="checkbox" data-ac="${a.id}"${acs.includes(a.id) ? ' checked' : ''}>
              <span>${esc(a.identifier)} <span class="muted tiny">${esc(a.model || '')}</span></span></label>`).join('')
              || '<p class="muted tiny">No aircraft on the register yet — add one under Fleet.</p>'}
          </div></div>
        <div class="field"><label>Crew</label>
          <div id="crewlist" class="stack" style="gap:7px"></div>
          <button class="btn sm" type="button" data-addcrew style="margin-top:8px">+ Add crew member</button></div>
        <div class="row c3">
          <div class="field"><label>Location</label>
            <input class="inp" data-f="location_name" value="${esc(job.location_name || '')}" placeholder="Cribb Road, Brendale"></div>
          <div class="field"><label>Latitude</label>
            <input class="inp" type="number" step="0.0000001" data-f="lat" value="${esc(job.lat ?? '')}"></div>
          <div class="field"><label>Longitude</label>
            <input class="inp" type="number" step="0.0000001" data-f="lng" value="${esc(job.lng ?? '')}"></div>
        </div>
        <div class="row c3">
          <div class="field"><label>Max job height (ft AGL)</label>
            <input class="inp" type="number" data-f="max_height_ft" value="${esc(job.max_height_ft ?? 400)}"></div>
          <div class="field"><label>CASA / CAAN approval</label>
            <select class="inp" data-f="casa_approval">
              ${['Not Required', 'Required — not yet held', 'Held'].map(o =>
                `<option${job.casa_approval === o ? ' selected' : ''}>${o}</option>`).join('')}
            </select></div>
          <div class="field"><label>&nbsp;</label>
            <label class="chk"><input type="checkbox" data-f="multiday"${job.multiday ? ' checked' : ''}><span>Multi-day job</span></label>
            <label class="chk"><input type="checkbox" data-f="tethered"${job.tethered ? ' checked' : ''}><span>Tethered operation</span></label>
          </div>
        </div>
        <div class="field"><label>Job details</label>
          <textarea class="inp" data-f="details" placeholder="What the flight is for.">${esc(job.details || '')}</textarea></div>
        <div class="field"><label>Emergency contacts</label>
          <textarea class="inp" data-f="emergency_contacts" placeholder="Name, licence/ARN, phone">${esc(job.emergency_contacts || '')}</textarea></div>
        <label class="chk"><input type="checkbox" data-f="maps_checked"${job.maps_checked ? ' checked' : ''}>
          <span>Maps and charts are available and have been checked</span></label>`;
      paintCrew();
      $('[data-addcrew]').onclick = () => { crew.push({ person_id: P[0]?.id || '', crew_role: 'pilot' }); paintCrew(); };
    }

    else if (step === 1) {
      b.innerHTML = `
        <p class="muted tiny" style="margin-top:0">Record each area you will use — operations area, take-off and landing,
          the emergency alternate, signage positions and the command centre.</p>
        <div id="arealist" class="stack"></div>
        <button class="btn sm" type="button" data-addarea style="margin-top:10px">+ Add area</button>`;
      paintAreas();
      $('[data-addarea]').onclick = () => {
        areas.push({ area_type: 'operations', label: '', lat: job.lat, lng: job.lng, ceiling_ft: job.max_height_ft || 400 });
        paintAreas();
      };
    }

    else if (step === 2) {
      const band = riskBand;
      b.innerHTML = `
        <div class="field"><label>Attach a risk assessment</label>
          <select class="inp" data-f="risk_assessment_id">${options(RAS || [], 'id', 'title', job.risk_assessment_id, '— none selected —')}</select>
          <div class="hint">Build and reuse assessments under Risk Library. Rating = likelihood + consequence.</div></div>
        <label class="chk"><input type="checkbox" data-f="ext_risk_done"${job.ext_risk_done ? ' checked' : ''}>
          <span>An external risk assessment has been completed for this job</span></label>
        <div class="divider"></div>
        <h4 style="margin-bottom:8px">Risk matrix</h4>
        <div class="tblwrap"><table class="matrix">
          <tr><th style="text-align:left">Likelihood \\ Consequence</th>
            ${['0 Almost none', '1 Insignificant', '2 Minor', '3 Moderate', '4 Major', '5 Catastrophic'].map(h => `<th>${h}</th>`).join('')}</tr>
          ${[5, 4, 3, 2, 1, 0].map(l => `<tr>
            <th style="text-align:left">${l} — ${['Extremely rare', 'Rare', 'Unlikely', 'Possible', 'Likely', 'Almost certain'][l]}</th>
            ${[0, 1, 2, 3, 4, 5].map(cc => { const r = band(l, cc); return `<td class="${r.cls}">${r.r} ${r.label}</td>`; }).join('')}
          </tr>`).join('')}
        </table></div>
        <p class="tiny muted" style="margin-bottom:0">EXTREME (8–10) and HIGH (6–7) — the task is not permitted until controls bring the
          residual risk down. MEDIUM (4–5) — may proceed, reduce to ALARP. LOW (0–3) — may proceed.</p>`;
    }

    else if (step === 3) {
      b.innerHTML = `
        <div class="between" style="margin-bottom:11px">
          <p class="muted tiny" style="margin:0">Tick each item and note how it was satisfied.</p>
          <button class="btn sm" type="button" data-allcheck>Check all</button>
        </div>
        <div class="card"><div class="bd tight">
          ${jsa.map((x, i) => `
            <div class="listitem">
              <label class="chk"><input type="checkbox" data-jsa="${i}"${x.checked ? ' checked' : ''}>
                <span><b style="font-weight:600">${esc(x.item_label)}</b></span></label>
              <input class="inp" style="margin-top:6px;font-size:13px" data-jsac="${i}"
                placeholder="Comment" value="${esc(x.comment || '')}">
            </div>`).join('')}
        </div></div>`;
      $('[data-allcheck]').onclick = () => {
        jsa.forEach(x => x.checked = true);
        $$('[data-jsa]').forEach(el => el.checked = true);
      };
      b.addEventListener('change', e => {
        const i = e.target.dataset.jsa; if (i !== undefined) jsa[i].checked = e.target.checked;
      });
      b.addEventListener('input', e => {
        const i = e.target.dataset.jsac; if (i !== undefined) jsa[i].comment = e.target.value;
      });
    }

    else if (step === 4) {
      const list = job.attachments || [];
      b.innerHTML = `
        <p class="muted tiny" style="margin-top:0">Link documents rather than uploading them — a Google Drive or
          Dropbox link set to “anyone with the link can view” keeps this app free to run.</p>
        <div id="attlist" class="stack"></div>
        <div class="row c2" style="margin-top:12px">
          <div class="field"><label>Title</label><input class="inp" id="att-t" placeholder="Landowner permission"></div>
          <div class="field"><label>Link</label><input class="inp" id="att-u" placeholder="https://…"></div>
        </div>
        <button class="btn sm" type="button" id="att-add">+ Add attachment</button>`;
      const paintAtt = () => {
        $('#attlist').innerHTML = list.length ? list.map((a, i) => `
          <div class="between card" style="padding:9px 12px">
            <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title || a.url)}</a>
            <button class="btn ghost sm" data-delatt="${i}">Remove</button>
          </div>`).join('') : '<p class="muted tiny">No attachments.</p>';
      };
      paintAtt();
      $('#att-add').onclick = () => {
        const t = $('#att-t').value.trim(), u = $('#att-u').value.trim();
        if (!u) return toast('Paste a link first', 'bad');
        list.push({ title: t || u, url: u }); job.attachments = list;
        $('#att-t').value = ''; $('#att-u').value = ''; paintAtt();
      };
      $('#attlist').onclick = e => {
        const i = e.target.dataset.delatt; if (i === undefined) return;
        list.splice(i, 1); job.attachments = list; paintAtt();
      };
    }

    else {
      b.innerHTML = `
        <p class="muted tiny" style="margin-top:0">The pilot in command signs here. Sign with a finger on a phone or tablet, or the mouse on a desktop.</p>
        <div class="between" style="margin-bottom:8px">
          <b>Signature</b>
          <div class="actions">
            <span class="tiny muted">${fmtDate(new Date())}</span>
            <button class="btn sm" type="button" id="sig-clear">Clear</button>
          </div>
        </div>
        <canvas id="sigpad"></canvas>
        ${sig ? `<p class="tiny muted" style="margin-top:8px">A signature is already on file for this job — drawing a new one replaces it.</p>` : ''}
        <div class="divider"></div>
        <div class="card" style="background:#fbfcfe"><div class="bd">
          <h4 style="margin-bottom:8px">Before you submit</h4>
          <ul class="tiny muted" style="margin:0;padding-left:18px;line-height:1.85">
            <li>Crew and aircraft are listed and current</li>
            <li>Every JSA item is checked with a comment where it matters</li>
            <li>The residual risk on every hazard is MEDIUM or lower</li>
            <li>Weather and NOTAMs are re-checked within 30 minutes of flight</li>
          </ul>
        </div></div>`;
      initSigPad();
    }
  }

  function paintCrew() {
    const el = $('#crewlist'); if (!el) return;
    el.innerHTML = crew.length ? crew.map((cw, i) => `
      <div class="row c2" style="grid-template-columns:2fr 1fr auto;gap:7px;align-items:center">
        <select class="inp" data-cp="${i}">${options(P, 'id', 'full_name', cw.person_id, '— select —')}</select>
        <select class="inp" data-cr="${i}">
          ${['pilot', 'instructor', 'observer', 'support'].map(r =>
            `<option value="${r}"${cw.crew_role === r ? ' selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`).join('')}
        </select>
        <button class="btn ghost sm" data-delcrew="${i}">&times;</button>
      </div>`).join('') : '<p class="muted tiny" style="margin:0">Nobody assigned yet.</p>';
    el.onchange = e => {
      const p = e.target.dataset.cp, r = e.target.dataset.cr;
      if (p !== undefined) crew[p].person_id = e.target.value;
      if (r !== undefined) crew[r].crew_role = e.target.value;
    };
    el.onclick = e => {
      const i = e.target.dataset.delcrew; if (i === undefined) return;
      crew.splice(i, 1); paintCrew();
    };
  }

  function paintAreas() {
    const el = $('#arealist'); if (!el) return;
    el.innerHTML = areas.length ? areas.map((a, i) => `
      <div class="card"><div class="bd">
        <div class="between" style="margin-bottom:9px">
          <b>Area ${i + 1}</b><button class="btn ghost sm" data-delarea="${i}">Remove</button>
        </div>
        <div class="row c3">
          <div class="field"><label>Type</label>
            <select class="inp" data-af="area_type" data-i="${i}">
              ${[['operations', 'Operations area'], ['takeoff_landing', 'Take-off & landing'],
                 ['emergency_landing', 'Emergency alternate'], ['signage', 'Signage'],
                 ['command_centre', 'Command centre']].map(([v, l]) =>
                `<option value="${v}"${a.area_type === v ? ' selected' : ''}>${l}</option>`).join('')}
            </select></div>
          <div class="field"><label>Label</label>
            <input class="inp" data-af="label" data-i="${i}" value="${esc(a.label || '')}"></div>
          <div class="field"><label>Ceiling (ft AGL)</label>
            <input class="inp" type="number" data-af="ceiling_ft" data-i="${i}" value="${esc(a.ceiling_ft ?? 400)}"></div>
        </div>
        <div class="row c4">
          <div class="field"><label>Latitude</label>
            <input class="inp" type="number" step="0.0000001" data-af="lat" data-i="${i}" value="${esc(a.lat ?? '')}"></div>
          <div class="field"><label>Longitude</label>
            <input class="inp" type="number" step="0.0000001" data-af="lng" data-i="${i}" value="${esc(a.lng ?? '')}"></div>
          <div class="field"><label>Airspace</label>
            <input class="inp" data-af="airspace" data-i="${i}" value="${esc(a.airspace || '')}" placeholder="Class G"></div>
          <div class="field"><label>Radio frequency</label>
            <input class="inp" data-af="radio_freq" data-i="${i}" value="${esc(a.radio_freq || '')}" placeholder="126.7"></div>
        </div>
      </div></div>`).join('') : '<p class="muted tiny" style="margin:0">No areas yet.</p>';
    el.onchange = el.oninput = e => {
      const f = e.target.dataset.af, i = e.target.dataset.i;
      if (f === undefined || i === undefined) return;
      areas[i][f] = e.target.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value;
    };
    el.onclick = e => {
      const i = e.target.dataset.delarea; if (i === undefined) return;
      areas.splice(i, 1); paintAreas();
    };
  }

  function initSigPad() {
    const cv = $('#sigpad'); if (!cv) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = cv.getBoundingClientRect();
    cv.width = rect.width * ratio; cv.height = rect.height * ratio;
    const ctx = cv.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.1; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#101722';
    if (sig) { const im = new Image(); im.onload = () => ctx.drawImage(im, 0, 0, rect.width, rect.height); im.src = sig; }
    let drawing = false;
    const pos = e => {
      const r = cv.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return [p.clientX - r.left, p.clientY - r.top];
    };
    const start = e => { e.preventDefault(); drawing = true; ctx.beginPath(); ctx.moveTo(...pos(e)); };
    const move  = e => { if (!drawing) return; e.preventDefault(); ctx.lineTo(...pos(e)); ctx.stroke(); };
    const end   = () => { if (!drawing) return; drawing = false; sig = cv.toDataURL('image/png'); };
    cv.addEventListener('mousedown', start); cv.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    cv.addEventListener('touchstart', start, { passive: false });
    cv.addEventListener('touchmove', move, { passive: false });
    cv.addEventListener('touchend', end);
    $('#sig-clear').onclick = () => { ctx.clearRect(0, 0, cv.width, cv.height); sig = null; };
  }

  function collect() {
    const body = $('#wbody');
    Object.assign(job, readForm(body));
    if (step === 0) acs = $$('[data-ac]', body).filter(el => el.checked).map(el => el.dataset.ac);
  }

  async function save(close) {
    collect();
    if (!job.name) { toast('Give the job a name', 'bad'); step = 0; render(); return null; }

    const payload = {
      job_type: job.job_type, name: job.name, client_id: job.client_id || null,
      internal_ref: job.internal_ref || null,
      job_date: job.job_date ? new Date(job.job_date).toISOString() : null,
      est_finish: job.est_finish ? new Date(job.est_finish).toISOString() : null,
      multiday: !!job.multiday, tethered: !!job.tethered,
      location_name: job.location_name || null,
      lat: job.lat ?? null, lng: job.lng ?? null,
      max_height_ft: job.max_height_ft ?? 400,
      details: job.details || null, emergency_contacts: job.emergency_contacts || null,
      maps_checked: !!job.maps_checked, ext_risk_done: !!job.ext_risk_done,
      casa_approval: job.casa_approval || 'Not Required',
      risk_assessment_id: job.risk_assessment_id || null,
      attachments: job.attachments || []
    };
    if (sig) { payload.signature = sig; payload.signed_by = S.me.id; payload.signed_at = new Date().toISOString(); }

    let id = existingId;
    if (id) {
      const { error } = await sb.from('crm_jobs').update(payload).eq('id', id);
      if (error) { toast(error.message, 'bad'); return null; }
    } else {
      payload.created_by = S.me.id;
      payload.status = 'draft';
      const { data, error } = await sb.from('crm_jobs').insert(payload).select('id').maybeSingle();
      if (error) { toast(error.message, 'bad'); return null; }
      id = data.id;
      existingId = id;   // subsequent saves update rather than duplicate
    }

    /* child rows: clear and rewrite — small tables, keeps it simple */
    await sb.from('crm_job_pilots').delete().eq('job_id', id);
    const cleanCrew = crew.filter(x => x.person_id);
    if (cleanCrew.length) await sb.from('crm_job_pilots').insert(cleanCrew.map(x => ({ job_id: id, ...x })));

    await sb.from('crm_job_aircraft').delete().eq('job_id', id);
    if (acs.length) await sb.from('crm_job_aircraft').insert(acs.map(a => ({ job_id: id, aircraft_id: a })));

    await sb.from('crm_job_jsa').delete().eq('job_id', id);
    if (jsa.length) await sb.from('crm_job_jsa').insert(jsa.map(x => ({
      job_id: id, item_key: x.item_key, item_label: x.item_label,
      checked: !!x.checked, comment: x.comment || null, sort_order: x.sort_order || 0
    })));

    await sb.from('crm_job_areas').delete().eq('job_id', id);
    if (areas.length) await sb.from('crm_job_areas').insert(areas.map(a => ({
      job_id: id, area_type: a.area_type, label: a.label || null,
      lat: a.lat ?? null, lng: a.lng ?? null, ceiling_ft: a.ceiling_ft ?? 400,
      airspace: a.airspace || null, radio_freq: a.radio_freq || null
    })));

    toast(close ? 'Job saved' : 'Saved', 'good');
    if (close) { closeModal(); go('jobs', id); }
    return id;
  }

  $('#modalbox').addEventListener('click', async e => {
    if (e.target.closest('[data-close]')) return closeModal();
    if (e.target.closest('[data-prev]')) { collect(); step--; render(); return; }
    if (e.target.closest('[data-next]')) { if (await save(false)) { step++; render(); } return; }
    if (e.target.closest('[data-save]')) { await save(false); return; }
    if (e.target.closest('[data-finish]')) { await save(true); return; }
    const st = e.target.closest('[data-step]');
    if (st) { collect(); step = Number(st.dataset.step); render(); }
  });

  render();
}

/* ---- Quick sign-off modal --------------------------------------- */
async function signJob(id) {
  let sig = null;
  modal(`
    <div class="mh"><h2>Sign off</h2><button class="x" data-close>&times;</button></div>
    <div class="mb">
      <p class="muted tiny" style="margin-top:0">Pilot in command signature.</p>
      <canvas id="sigpad"></canvas>
    </div>
    <div class="mf">
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn" id="sc">Clear</button>
      <button class="btn pri" id="sv">Save signature</button>
    </div>`, { noFocus: true });

  const cv = $('#sigpad'), ratio = window.devicePixelRatio || 1, rect = cv.getBoundingClientRect();
  cv.width = rect.width * ratio; cv.height = rect.height * ratio;
  const ctx = cv.getContext('2d'); ctx.scale(ratio, ratio);
  ctx.lineWidth = 2.1; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#101722';
  let d = false;
  const pos = e => { const r = cv.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return [p.clientX - r.left, p.clientY - r.top]; };
  const s = e => { e.preventDefault(); d = true; ctx.beginPath(); ctx.moveTo(...pos(e)); };
  const m = e => { if (!d) return; e.preventDefault(); ctx.lineTo(...pos(e)); ctx.stroke(); };
  const u = () => { if (!d) return; d = false; sig = cv.toDataURL('image/png'); };
  cv.addEventListener('mousedown', s); cv.addEventListener('mousemove', m); window.addEventListener('mouseup', u);
  cv.addEventListener('touchstart', s, { passive: false }); cv.addEventListener('touchmove', m, { passive: false }); cv.addEventListener('touchend', u);
  $('#sc').onclick = () => { ctx.clearRect(0, 0, cv.width, cv.height); sig = null; };
  $('#sv').onclick = async () => {
    if (!sig) return toast('Nothing drawn yet', 'bad');
    const { error } = await sb.from('crm_jobs').update({
      signature: sig, signed_by: S.me.id, signed_at: new Date().toISOString()
    }).eq('id', id);
    if (error) return toast(error.message, 'bad');
    closeModal(); toast('Signed', 'good'); go('jobs', id);
  };
  $('#modalbox').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(); });
}

/* ---------------------------------------------------------------- */
/* FLIGHT LOG                                                        */
/* ---------------------------------------------------------------- */
route('flights', {
  title: 'Flight Log', group: 'Operations', icon: 'log', nav: 'Flight Log',
  sub: 'Every flight, logged and totalled',
  render: async (c) => {
    const admin = ['super_admin', 'instructor'].includes(S.me.role);
    const [F, P, A] = await Promise.all([
      q(sb.from('crm_flights').select('*').order('flight_date', { ascending: false }).limit(800), 'flights'),
      people(), aircraft()
    ]);
    const rows = F || [];
    const mineRows = rows.filter(r => r.person_id === S.me.id);
    const total = mineRows.reduce((a, b) => a + Number(b.flight_hours || 0), 0);
    const pic   = mineRows.filter(r => r.capacity === 'pic').reduce((a, b) => a + Number(b.flight_hours || 0), 0);
    const dual  = mineRows.filter(r => r.capacity === 'dual').reduce((a, b) => a + Number(b.flight_hours || 0), 0);
    const d90   = mineRows.filter(r => daysUntil(r.flight_date) >= -90).reduce((a, b) => a + Number(b.flight_hours || 0), 0);
    const lands = mineRows.reduce((a, b) => a + Number(b.landings || 0), 0);

    c.innerHTML = `
      <div class="tiles">
        <div class="tile"><div class="lbl">Total hours</div><div class="val">${hrs(total)}</div><div class="sub">${mineRows.length} flights</div></div>
        <div class="tile green"><div class="lbl">Pilot in command</div><div class="val">${hrs(pic)}</div></div>
        <div class="tile"><div class="lbl">Dual / instruction</div><div class="val">${hrs(dual)}</div></div>
        <div class="tile amber"><div class="lbl">Last 90 days</div><div class="val">${hrs(d90)}</div><div class="sub">recency</div></div>
        <div class="tile"><div class="lbl">Landings</div><div class="val">${lands}</div></div>
      </div>
      <div class="searchbar">
        <input class="inp" id="ff-q" placeholder="Search location, aircraft or remarks…">
        ${admin ? `<select class="inp" id="ff-p"><option value="">Everyone</option>${options(P, 'id', 'full_name', S.me.id)}</select>` : ''}
        <button class="btn" id="ff-csv">Export CSV</button>
        <button class="btn pri" id="ff-new">Log a flight</button>
      </div>
      <div class="card"><div class="bd tight"><div class="tblwrap">
        <table class="tbl"><thead><tr>
          <th>Date</th><th>Aircraft</th><th>Pilot</th><th>Type</th><th>Capacity</th>
          <th>Location</th><th class="num">Hours</th><th class="num">Ldg</th><th>Remarks</th><th></th>
        </tr></thead><tbody id="fbody"></tbody></table>
      </div></div></div>`;

    function paint() {
      const term = ($('#ff-q').value || '').toLowerCase();
      const who  = admin ? $('#ff-p').value : S.me.id;
      const list = rows.filter(r =>
        (!who || r.person_id === who) &&
        (!term || (r.location || '').toLowerCase().includes(term) ||
                  (r.remarks || '').toLowerCase().includes(term) ||
                  acOf(A, r.aircraft_id).toLowerCase().includes(term)));
      $('#fbody').innerHTML = list.length ? list.map(r => `
        <tr>
          <td class="nowrap">${fmtDate(r.flight_date)}</td>
          <td>${dash(acOf(A, r.aircraft_id))}</td>
          <td class="tiny">${dash(nameOf(P, r.person_id))}</td>
          <td><span class="tag ${esc(r.flight_type)}">${esc(r.flight_type)}</span></td>
          <td class="tiny">${esc(r.capacity)}</td>
          <td class="tiny">${dash(r.location)}</td>
          <td class="num"><b>${hrs(r.flight_hours)}</b></td>
          <td class="num">${esc(r.landings ?? '')}</td>
          <td class="tiny">${dash(r.remarks)}</td>
          <td>${(r.person_id === S.me.id || admin)
            ? `<button class="btn ghost sm" data-delflight="${r.id}">&times;</button>` : ''}</td>
        </tr>`).join('') : `<tr><td colspan="10"><div class="empty"><b>Nothing logged yet</b><p>Finish a job and log its flight time, or add an entry by hand.</p></div></td></tr>`;
    }
    paint();
    $('#ff-q').oninput = paint;
    if (admin) $('#ff-p').onchange = paint;
    $('#ff-new').onclick = () => flightForm(null, P, A);
    $('#ff-csv').onclick = () => csv(
      [['Date', 'Aircraft', 'Pilot', 'Type', 'Capacity', 'Day/Night', 'Location', 'Hours', 'Duty', 'Landings', 'Remarks']]
        .concat(rows.filter(r => admin || r.person_id === S.me.id).map(r =>
          [r.flight_date, acOf(A, r.aircraft_id), nameOf(P, r.person_id), r.flight_type, r.capacity,
           r.day_night, r.location, r.flight_hours, r.duty_hours, r.landings, r.remarks])),
      `eastern-uav-flightlog-${todayISO()}.csv`);

    $('#fbody').onclick = async e => {
      const id = e.target.dataset.delflight; if (!id) return;
      if (!await confirmBox('Delete this entry?', 'The flight time will be taken back off the aircraft total.', 'Delete')) return;
      const { error } = await sb.from('crm_flights').delete().eq('id', id);
      if (error) return toast(error.message, 'bad');
      toast('Deleted', 'good'); go('flights');
    };
  }
});

async function flightForm(jobId, P, A) {
  P = P || await people(); A = A || await aircraft();
  modal(`
    <div class="mh"><h2>Log a flight</h2><button class="x" data-close>&times;</button></div>
    <div class="mb">
      <div class="row c3">
        <div class="field"><label>Date</label><input class="inp" type="date" data-f="flight_date" value="${todayISO()}"></div>
        <div class="field"><label>Aircraft</label><select class="inp" data-f="aircraft_id">${options(A, 'id', 'identifier', '', '— select —')}</select></div>
        <div class="field"><label>Pilot</label><select class="inp" data-f="person_id">${options(P, 'id', 'full_name', S.me.id)}</select></div>
      </div>
      <div class="row c4">
        <div class="field"><label>Flight hours</label><input class="inp" type="number" step="0.01" data-f="flight_hours" value="0.00"></div>
        <div class="field"><label>Duty hours</label><input class="inp" type="number" step="0.01" data-f="duty_hours" value="0.00"></div>
        <div class="field"><label>Landings</label><input class="inp" type="number" data-f="landings" value="1"></div>
        <div class="field"><label>Day / night</label><select class="inp" data-f="day_night"><option value="day">Day</option><option value="night">Night</option></select></div>
      </div>
      <div class="row c3">
        <div class="field"><label>Type</label><select class="inp" data-f="flight_type">
          <option value="TRA">TRA — Training</option><option value="OPS">OPS — Operational</option><option value="PROF">PROF — Proficiency</option></select></div>
        <div class="field"><label>Capacity</label><select class="inp" data-f="capacity">
          <option value="pic">Pilot in command</option><option value="dual">Dual / under instruction</option>
          <option value="observer">Observer</option><option value="sim">Simulator</option></select></div>
        <div class="field"><label>Instructor</label><select class="inp" data-f="instructor_id">${options(P, 'id', 'full_name', '', '— none —')}</select></div>
      </div>
      <div class="field"><label>Location</label><input class="inp" data-f="location"></div>
      <div class="field"><label>Conditions</label><input class="inp" data-f="conditions" placeholder="CAVOK, 8 kt SE"></div>
      <div class="field"><label>Remarks</label><textarea class="inp" data-f="remarks"></textarea></div>
    </div>
    <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn pri" id="fsave">Save entry</button></div>`);

  $('#modalbox').onclick = e => { if (e.target.closest('[data-close]')) closeModal(); };
  $('#fsave').onclick = async () => {
    const d = readForm($('#modalbox'));
    if (!d.aircraft_id) return toast('Pick an aircraft', 'bad');
    d.job_id = jobId || null;
    const { error } = await sb.from('crm_flights').insert(d);
    if (error) return toast(error.message, 'bad');
    closeModal(); toast('Flight logged', 'good');
    S.cache.aircraft = null;
    go(jobId ? 'jobs' : 'flights', jobId || undefined);
  };
}

/* ---------------------------------------------------------------- */
/* QUALIFICATIONS & CURRENCY                                         */
/* ---------------------------------------------------------------- */
const QUAL_TYPES = ['RePL', 'ReOC', 'RPC', 'CAAN Remote Pilot Licence', 'Medical',
                    'AROC / Radio', 'Type Rating', 'Flight Review', 'First Aid', 'Other'];

route('quals', {
  title: 'Qualifications & Currency', group: 'Compliance', icon: 'qual', nav: 'Currency',
  sub: 'Licences, ratings and expiry tracking',
  render: async (c) => {
    const admin = ['super_admin', 'instructor'].includes(S.me.role);
    const [Q, P] = await Promise.all([
      q(sb.from('crm_qualifications').select('*').order('expires_on', { nullsFirst: false }), 'qualifications'),
      people()
    ]);
    const rows = Q || [];
    const scoped = admin ? rows : rows.filter(r => r.person_id === S.me.id);
    const withExp = scoped.filter(r => r.expires_on);
    const expired = withExp.filter(r => daysUntil(r.expires_on) < 0);
    const soon    = withExp.filter(r => { const d = daysUntil(r.expires_on); return d >= 0 && d <= 60; });

    c.innerHTML = `
      <div class="tiles">
        <div class="tile"><div class="lbl">On the register</div><div class="val">${scoped.length}</div></div>
        <div class="tile ${expired.length ? 'red' : 'green'}"><div class="lbl">Expired</div><div class="val">${expired.length}</div></div>
        <div class="tile ${soon.length ? 'amber' : 'green'}"><div class="lbl">Within 60 days</div><div class="val">${soon.length}</div></div>
        <div class="tile green"><div class="lbl">Current</div><div class="val">${scoped.length - expired.length - soon.length}</div></div>
      </div>
      <div class="searchbar">
        <input class="inp" id="qf-q" placeholder="Search title, type or reference…">
        ${admin ? `<select class="inp" id="qf-p"><option value="">Everyone</option>${options(P, 'id', 'full_name', '')}</select>` : ''}
        <button class="btn" id="qf-csv">Export CSV</button>
        <button class="btn pri" id="qf-new">Add qualification</button>
      </div>
      <div class="card"><div class="bd tight"><div class="tblwrap">
        <table class="tbl"><thead><tr>
          <th>Holder</th><th>Type</th><th>Title</th><th>Reference</th><th>Issuer</th>
          <th>Issued</th><th>Expires</th><th>Status</th><th></th>
        </tr></thead><tbody id="qbody"></tbody></table>
      </div></div></div>`;

    function paint() {
      const term = ($('#qf-q').value || '').toLowerCase();
      const who  = admin ? $('#qf-p').value : '';
      const list = scoped.filter(r =>
        (!who || r.person_id === who) &&
        (!term || (r.title || '').toLowerCase().includes(term) ||
                  (r.qual_type || '').toLowerCase().includes(term) ||
                  (r.reference_no || '').toLowerCase().includes(term)));
      $('#qbody').innerHTML = list.length ? list.map(r => {
        const d = daysUntil(r.expires_on);
        const st = !r.expires_on ? '<span class="pill grey">No expiry</span>'
          : d < 0 ? `<span class="pill red">Expired ${-d} d ago</span>`
          : d <= 30 ? `<span class="pill red">${d} days</span>`
          : d <= 60 ? `<span class="pill amber">${d} days</span>`
          : `<span class="pill green">Current</span>`;
        return `<tr>
          <td class="tiny">${dash(nameOf(P, r.person_id))}</td>
          <td><span class="pill blue">${esc(r.qual_type)}</span></td>
          <td><b>${esc(r.title)}</b></td>
          <td class="mono tiny">${dash(r.reference_no)}</td>
          <td class="tiny">${dash(r.issuer)}</td>
          <td class="nowrap tiny">${fmtDate(r.issued_on)}</td>
          <td class="nowrap tiny">${fmtDate(r.expires_on)}</td>
          <td>${st}</td>
          <td class="nowrap"><div class="actions">
            ${r.document_url ? `<a class="btn sm" href="${esc(r.document_url)}" target="_blank" rel="noopener">Doc</a>` : ''}
            <button class="btn sm" data-editq="${r.id}">Edit</button></div></td>
        </tr>`; }).join('') : `<tr><td colspan="9"><div class="empty"><b>Nothing on the register</b><p>Add licences, medicals, radio and type ratings so expiry warnings can do their job.</p></div></td></tr>`;
    }
    paint();
    $('#qf-q').oninput = paint;
    if (admin) $('#qf-p').onchange = paint;
    $('#qf-new').onclick = () => qualForm(null, P);
    $('#qbody').onclick = e => {
      const id = e.target.dataset.editq; if (!id) return;
      qualForm(rows.find(r => r.id === id), P);
    };
    $('#qf-csv').onclick = () => csv(
      [['Holder', 'Type', 'Title', 'Reference', 'Issuer', 'Issued', 'Expires', 'Days to expiry']]
        .concat(scoped.map(r => [nameOf(P, r.person_id), r.qual_type, r.title, r.reference_no,
          r.issuer, r.issued_on, r.expires_on, daysUntil(r.expires_on)])),
      `eastern-uav-currency-${todayISO()}.csv`);
  }
});

async function qualForm(row, P) {
  const admin = ['super_admin', 'instructor'].includes(S.me.role);
  const r = row || {};
  modal(`
    <div class="mh"><h2>${row ? 'Edit' : 'Add'} qualification</h2><button class="x" data-close>&times;</button></div>
    <div class="mb">
      <div class="row c2">
        <div class="field"><label>Holder</label>
          <select class="inp" data-f="person_id"${admin ? '' : ' disabled'}>${options(P, 'id', 'full_name', r.person_id || S.me.id)}</select></div>
        <div class="field"><label>Type</label>
          <select class="inp" data-f="qual_type">${QUAL_TYPES.map(t => `<option${r.qual_type === t ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Title</label>
        <input class="inp" data-f="title" value="${esc(r.title || '')}" placeholder="Remote Pilot Licence — Multirotor sub-25 kg"></div>
      <div class="row c2">
        <div class="field"><label>Reference number</label><input class="inp" data-f="reference_no" value="${esc(r.reference_no || '')}"></div>
        <div class="field"><label>Issuer</label><input class="inp" data-f="issuer" value="${esc(r.issuer || '')}" placeholder="CASA / CAAN"></div>
      </div>
      <div class="row c2">
        <div class="field"><label>Issued on</label><input class="inp" type="date" data-f="issued_on" value="${esc(r.issued_on || '')}"></div>
        <div class="field"><label>Expires on</label><input class="inp" type="date" data-f="expires_on" value="${esc(r.expires_on || '')}">
          <div class="hint">Leave blank if it does not expire.</div></div>
      </div>
      <div class="field"><label>Document link</label><input class="inp" data-f="document_url" value="${esc(r.document_url || '')}" placeholder="https://…"></div>
      <div class="field"><label>Notes</label><textarea class="inp" data-f="notes">${esc(r.notes || '')}</textarea></div>
    </div>
    <div class="mf">
      ${row && admin ? '<button class="btn dang" id="qdel">Delete</button>' : ''}
      <div style="flex:1"></div>
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn pri" id="qsave">Save</button>
    </div>`);
  $('#modalbox').onclick = e => { if (e.target.closest('[data-close]')) closeModal(); };
  if ($('#qdel')) $('#qdel').onclick = async () => {
    if (!await confirmBox('Delete this qualification?', 'It will be removed from the currency register.', 'Delete')) return;
    const { error } = await sb.from('crm_qualifications').delete().eq('id', row.id);
    if (error) return toast(error.message, 'bad');
    closeModal(); toast('Deleted', 'good'); go('quals');
  };
  $('#qsave').onclick = async () => {
    const d = readForm($('#modalbox'));
    if (!d.title) return toast('Give it a title', 'bad');
    if (!admin) d.person_id = S.me.id;
    const res = row
      ? await sb.from('crm_qualifications').update(d).eq('id', row.id)
      : await sb.from('crm_qualifications').insert(d);
    if (res.error) return toast(res.error.message, 'bad');
    closeModal(); toast('Saved', 'good'); go('quals');
  };
}

/* ---------------------------------------------------------------- */
/* FLEET                                                             */
/* ---------------------------------------------------------------- */
route('fleet', {
  title: 'Fleet', group: 'Operations', icon: 'fleet',
  sub: 'Aircraft and battery register',
  render: async (c) => {
    const admin = ['super_admin', 'instructor'].includes(S.me.role);
    const [A, B, M] = await Promise.all([
      aircraft(true),
      q(sb.from('crm_batteries').select('*').order('label'), 'batteries'),
      q(sb.from('crm_maintenance').select('aircraft_id,next_due_on,performed_on').order('performed_on', { ascending: false }), 'maintenance')
    ]);
    const nextDue = {};
    (M || []).forEach(m => { if (!nextDue[m.aircraft_id] && m.next_due_on) nextDue[m.aircraft_id] = m.next_due_on; });

    c.innerHTML = `
      <div class="tiles">
        <div class="tile"><div class="lbl">Aircraft</div><div class="val">${A.length}</div>
          <div class="sub">${A.filter(a => a.status === 'serviceable').length} serviceable</div></div>
        <div class="tile ${A.some(a => a.status === 'unserviceable') ? 'red' : 'green'}">
          <div class="lbl">Unserviceable</div><div class="val">${A.filter(a => a.status === 'unserviceable').length}</div></div>
        <div class="tile green"><div class="lbl">Fleet hours</div>
          <div class="val">${hrs(A.reduce((s, a) => s + Number(a.total_hours || 0), 0))}</div></div>
        <div class="tile"><div class="lbl">Batteries</div><div class="val">${(B || []).length}</div>
          <div class="sub">${(B || []).filter(b => b.cycle_limit && b.cycles >= b.cycle_limit).length} at cycle limit</div></div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="hd"><h3>Aircraft</h3>
          ${admin ? '<button class="btn pri sm" id="ac-new">Add aircraft</button>' : ''}</div>
        <div class="bd tight"><div class="tblwrap"><table class="tbl">
          <thead><tr><th>Identifier</th><th>Make / model</th><th>Category</th><th>Class</th>
            <th>Serial</th><th class="num">Hours</th><th>Next maintenance</th><th>Status</th><th></th></tr></thead>
          <tbody>${A.length ? A.map(a => {
            const dd = daysUntil(nextDue[a.id]);
            return `<tr>
              <td><b class="mono">${esc(a.identifier)}</b></td>
              <td class="tiny">${esc([a.manufacturer, a.model].filter(Boolean).join(' '))}</td>
              <td class="tiny">${esc((a.category || '').replace(/_/g, ' '))}</td>
              <td class="tiny">${esc((a.weight_class || '').replace(/_/g, ' '))}</td>
              <td class="mono tiny">${dash(a.serial_no)}</td>
              <td class="num">${hrs(a.total_hours)}</td>
              <td class="tiny">${nextDue[a.id]
                ? `${fmtDate(nextDue[a.id])} <span class="pill ${dd < 0 ? 'red' : dd <= 30 ? 'amber' : 'grey'}">${dd < 0 ? 'overdue' : dd + ' d'}</span>`
                : '<span class="muted">—</span>'}</td>
              <td><span class="pill ${a.status === 'serviceable' ? 'green' : a.status === 'retired' ? 'grey' : 'red'}">${esc(a.status)}</span></td>
              <td class="nowrap"><div class="actions">
                <button class="btn sm" data-maint="${a.id}">Maintenance</button>
                ${admin ? `<button class="btn sm" data-editac="${a.id}">Edit</button>` : ''}</div></td>
            </tr>`; }).join('')
            : `<tr><td colspan="9"><div class="empty"><b>No aircraft yet</b><p>Add your RPA so jobs, flights and maintenance have something to attach to.</p>${admin ? '<button class="btn pri" id="ac-new2">Add the first aircraft</button>' : ''}</div></td></tr>`}
          </tbody>
        </table></div></div>
      </div>

      <div class="card">
        <div class="hd"><h3>Batteries</h3>
          ${admin ? '<button class="btn sm" id="bt-new">Add battery</button>' : ''}</div>
        <div class="bd tight"><div class="tblwrap"><table class="tbl">
          <thead><tr><th>Label</th><th>Aircraft</th><th>Chemistry</th><th>Capacity</th>
            <th class="num">Cycles</th><th>Life</th><th>Status</th><th></th></tr></thead>
          <tbody>${(B || []).length ? (B || []).map(b => {
            const pct = b.cycle_limit ? Math.min(100, Math.round(b.cycles / b.cycle_limit * 100)) : 0;
            return `<tr>
              <td><b class="mono">${esc(b.label)}</b></td>
              <td class="tiny">${dash(acOf(A, b.aircraft_id))}</td>
              <td class="tiny">${esc(b.chemistry || '')}${b.cells ? ' ' + b.cells + 'S' : ''}</td>
              <td class="tiny">${b.capacity_mah ? b.capacity_mah + ' mAh' : '<span class="muted">—</span>'}</td>
              <td class="num">${b.cycles} / ${b.cycle_limit || '—'}</td>
              <td style="min-width:110px"><div class="bar"><i style="width:${pct}%;background:${pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--amber)' : 'var(--green)'}"></i></div></td>
              <td><span class="pill ${b.status === 'serviceable' ? 'green' : 'red'}">${esc(b.status)}</span></td>
              <td>${admin ? `<button class="btn sm" data-editbt="${b.id}">Edit</button>` : ''}</td>
            </tr>`; }).join('')
            : `<tr><td colspan="8"><div class="empty tiny">No batteries recorded.</div></td></tr>`}
          </tbody>
        </table></div></div>
      </div>`;

    const openAC = id => aircraftForm(A.find(a => a.id === id));
    if ($('#ac-new'))  $('#ac-new').onclick  = () => aircraftForm(null);
    if ($('#ac-new2')) $('#ac-new2').onclick = () => aircraftForm(null);
    if ($('#bt-new'))  $('#bt-new').onclick  = () => batteryForm(null, A);
    c.onclick = e => {
      const ea = e.target.dataset.editac, eb = e.target.dataset.editbt, mm = e.target.dataset.maint;
      if (ea) openAC(ea);
      if (eb) batteryForm((B || []).find(x => x.id === eb), A);
      if (mm) go('maintenance', mm);
    };
  }
});

async function aircraftForm(row) {
  const a = row || {};
  modal(`
    <div class="mh"><h2>${row ? 'Edit' : 'Add'} aircraft</h2><button class="x" data-close>&times;</button></div>
    <div class="mb">
      <div class="row c2">
        <div class="field"><label>Identifier</label>
          <input class="inp" data-f="identifier" value="${esc(a.identifier || '')}" placeholder="M600-001"></div>
        <div class="field"><label>Status</label>
          <select class="inp" data-f="status">${['serviceable', 'unserviceable', 'maintenance', 'retired']
            .map(s => `<option value="${s}"${a.status === s ? ' selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select></div>
      </div>
      <div class="row c2">
        <div class="field"><label>Manufacturer</label><input class="inp" data-f="manufacturer" value="${esc(a.manufacturer || '')}" placeholder="DJI"></div>
        <div class="field"><label>Model</label><input class="inp" data-f="model" value="${esc(a.model || '')}" placeholder="Matrice 600"></div>
      </div>
      <div class="row c3">
        <div class="field"><label>Category</label>
          <select class="inp" data-f="category">${[['multirotor', 'Multirotor'], ['fixed_wing', 'Fixed wing'],
            ['helicopter', 'Helicopter'], ['vtol', 'VTOL'], ['other', 'Other']]
            .map(([v, l]) => `<option value="${v}"${a.category === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>Weight class</label>
          <select class="inp" data-f="weight_class">${[['micro', 'Micro (≤250 g)'], ['very_small', 'Very small (≤2 kg)'],
            ['small', 'Small (≤7 kg)'], ['sub_25kg', 'Sub-25 kg'], ['medium', 'Medium (≤150 kg)'], ['large', 'Large (>150 kg)']]
            .map(([v, l]) => `<option value="${v}"${a.weight_class === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>MTOW (kg)</label><input class="inp" type="number" step="0.01" data-f="mtow_kg" value="${esc(a.mtow_kg ?? '')}"></div>
      </div>
      <div class="row c3">
        <div class="field"><label>Serial number</label><input class="inp" data-f="serial_no" value="${esc(a.serial_no || '')}"></div>
        <div class="field"><label>Registration</label><input class="inp" data-f="registration" value="${esc(a.registration || '')}"></div>
        <div class="field"><label>Base</label><input class="inp" data-f="base" value="${esc(a.base || '')}"></div>
      </div>
      <div class="field"><label>Notes</label><textarea class="inp" data-f="notes">${esc(a.notes || '')}</textarea></div>
    </div>
    <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn pri" id="asave">Save</button></div>`);
  $('#modalbox').onclick = e => { if (e.target.closest('[data-close]')) closeModal(); };
  $('#asave').onclick = async () => {
    const d = readForm($('#modalbox'));
    if (!d.identifier) return toast('Give it an identifier', 'bad');
    const res = row ? await sb.from('crm_aircraft').update(d).eq('id', row.id)
                    : await sb.from('crm_aircraft').insert(d);
    if (res.error) return toast(res.error.message, 'bad');
    closeModal(); toast('Saved', 'good'); S.cache.aircraft = null; go('fleet');
  };
}

async function batteryForm(row, A) {
  const b = row || {};
  modal(`
    <div class="mh"><h2>${row ? 'Edit' : 'Add'} battery</h2><button class="x" data-close>&times;</button></div>
    <div class="mb">
      <div class="row c2">
        <div class="field"><label>Label</label><input class="inp" data-f="label" value="${esc(b.label || '')}" placeholder="TB48-003"></div>
        <div class="field"><label>Assigned aircraft</label>
          <select class="inp" data-f="aircraft_id">${options(A, 'id', 'identifier', b.aircraft_id, '— unassigned —')}</select></div>
      </div>
      <div class="row c4">
        <div class="field"><label>Chemistry</label><input class="inp" data-f="chemistry" value="${esc(b.chemistry || 'LiPo')}"></div>
        <div class="field"><label>Cells</label><input class="inp" type="number" data-f="cells" value="${esc(b.cells ?? '')}"></div>
        <div class="field"><label>Capacity (mAh)</label><input class="inp" type="number" data-f="capacity_mah" value="${esc(b.capacity_mah ?? '')}"></div>
        <div class="field"><label>Status</label>
          <select class="inp" data-f="status">${['serviceable', 'unserviceable', 'retired']
            .map(s => `<option value="${s}"${b.status === s ? ' selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select></div>
      </div>
      <div class="row c3">
        <div class="field"><label>Cycles used</label><input class="inp" type="number" data-f="cycles" value="${esc(b.cycles ?? 0)}"></div>
        <div class="field"><label>Cycle limit</label><input class="inp" type="number" data-f="cycle_limit" value="${esc(b.cycle_limit ?? 200)}"></div>
        <div class="field"><label>First use</label><input class="inp" type="date" data-f="first_use_on" value="${esc(b.first_use_on || '')}"></div>
      </div>
      <div class="field"><label>Notes</label><textarea class="inp" data-f="notes">${esc(b.notes || '')}</textarea></div>
    </div>
    <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn pri" id="bsave">Save</button></div>`);
  $('#modalbox').onclick = e => { if (e.target.closest('[data-close]')) closeModal(); };
  $('#bsave').onclick = async () => {
    const d = readForm($('#modalbox'));
    if (!d.label) return toast('Give it a label', 'bad');
    const res = row ? await sb.from('crm_batteries').update(d).eq('id', row.id)
                    : await sb.from('crm_batteries').insert(d);
    if (res.error) return toast(res.error.message, 'bad');
    closeModal(); toast('Saved', 'good'); go('fleet');
  };
}

/* ---------------------------------------------------------------- */
/* MAINTENANCE                                                       */
/* ---------------------------------------------------------------- */
route('maintenance', {
  title: 'Maintenance', group: 'Operations', icon: 'maint',
  sub: 'Servicing, inspections and firmware',
  render: async (c, acFilter) => {
    const admin = ['super_admin', 'instructor'].includes(S.me.role);
    const [M, A] = await Promise.all([
      q(sb.from('crm_maintenance').select('*').order('performed_on', { ascending: false }), 'maintenance'),
      aircraft()
    ]);
    const rows = (M || []).filter(m => !acFilter || m.aircraft_id === acFilter);

    c.innerHTML = `
      <div class="searchbar">
        <select class="inp" id="mf-ac"><option value="">All aircraft</option>${options(A, 'id', 'identifier', acFilter || '')}</select>
        <div style="flex:1"></div>
        ${admin ? '<button class="btn pri" id="mf-new">Record maintenance</button>' : ''}
      </div>
      <div class="card"><div class="bd tight"><div class="tblwrap">
        <table class="tbl"><thead><tr>
          <th>Date</th><th>Aircraft</th><th>Type</th><th>Description</th>
          <th class="num">Hours at</th><th>By</th><th>Next due</th><th></th>
        </tr></thead><tbody>${rows.length ? rows.map(m => {
          const dd = daysUntil(m.next_due_on);
          return `<tr>
            <td class="nowrap">${fmtDate(m.performed_on)}</td>
            <td><b class="mono">${esc(acOf(A, m.aircraft_id))}</b></td>
            <td><span class="pill blue">${esc((m.maint_type || '').replace(/_/g, ' '))}</span></td>
            <td>${esc(m.description)}</td>
            <td class="num">${m.hours_at ? hrs(m.hours_at) : '—'}</td>
            <td class="tiny">${dash(m.performed_by)}</td>
            <td class="tiny nowrap">${m.next_due_on
              ? `${fmtDate(m.next_due_on)} <span class="pill ${dd < 0 ? 'red' : dd <= 30 ? 'amber' : 'grey'}">${dd < 0 ? 'overdue' : dd + ' d'}</span>`
              : '<span class="muted">—</span>'}</td>
            <td>${m.document_url ? `<a class="btn sm" href="${esc(m.document_url)}" target="_blank" rel="noopener">Doc</a>` : ''}</td>
          </tr>`; }).join('')
          : `<tr><td colspan="8"><div class="empty"><b>No maintenance recorded</b><p>Log servicing and inspections so the next-due dates show up on the fleet register.</p></div></td></tr>`}
        </tbody></table>
      </div></div></div>`;

    $('#mf-ac').onchange = e => go('maintenance', e.target.value || undefined);
    if ($('#mf-new')) $('#mf-new').onclick = () => maintForm(A, acFilter);
  }
});

async function maintForm(A, preselect) {
  modal(`
    <div class="mh"><h2>Record maintenance</h2><button class="x" data-close>&times;</button></div>
    <div class="mb">
      <div class="row c3">
        <div class="field"><label>Aircraft</label>
          <select class="inp" data-f="aircraft_id">${options(A, 'id', 'identifier', preselect || '', '— select —')}</select></div>
        <div class="field"><label>Type</label>
          <select class="inp" data-f="maint_type">${[['scheduled', 'Scheduled'], ['unscheduled', 'Unscheduled'],
            ['inspection', 'Inspection'], ['modification', 'Modification'], ['firmware', 'Firmware']]
            .map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
        <div class="field"><label>Performed on</label><input class="inp" type="date" data-f="performed_on" value="${todayISO()}"></div>
      </div>
      <div class="row c2">
        <div class="field"><label>Airframe hours at time</label><input class="inp" type="number" step="0.01" data-f="hours_at"></div>
        <div class="field"><label>Performed by</label><input class="inp" data-f="performed_by"></div>
      </div>
      <div class="field"><label>Description</label><textarea class="inp" data-f="description" placeholder="What was done."></textarea></div>
      <div class="row c3">
        <div class="field"><label>Next due (date)</label><input class="inp" type="date" data-f="next_due_on"></div>
        <div class="field"><label>Next due (hours)</label><input class="inp" type="number" step="0.01" data-f="next_due_hours"></div>
        <div class="field"><label>Document link</label><input class="inp" data-f="document_url" placeholder="https://…"></div>
      </div>
    </div>
    <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn pri" id="msave">Save</button></div>`);
  $('#modalbox').onclick = e => { if (e.target.closest('[data-close]')) closeModal(); };
  $('#msave').onclick = async () => {
    const d = readForm($('#modalbox'));
    if (!d.aircraft_id || !d.description) return toast('Aircraft and description are required', 'bad');
    const { error } = await sb.from('crm_maintenance').insert(d);
    if (error) return toast(error.message, 'bad');
    closeModal(); toast('Recorded', 'good'); go('maintenance');
  };
}

/* ---------------------------------------------------------------- */
/* DEFECTS                                                           */
/* ---------------------------------------------------------------- */
route('defects', {
  title: 'Defects', group: 'Compliance', icon: 'maint',
  sub: 'Raise, track and close out defects',
  render: async (c) => {
    const admin = ['super_admin', 'instructor'].includes(S.me.role);
    const [D, A, P] = await Promise.all([
      q(sb.from('crm_defects').select('*').order('reported_on', { ascending: false }), 'defects'),
      aircraft(), people()
    ]);
    const rows = D || [];
    setCount('defects', rows.filter(r => r.status !== 'closed').length);

    c.innerHTML = `
      <div class="tiles">
        <div class="tile ${rows.filter(r => r.status === 'open').length ? 'red' : 'green'}">
          <div class="lbl">Open</div><div class="val">${rows.filter(r => r.status === 'open').length}</div></div>
        <div class="tile amber"><div class="lbl">Monitoring</div><div class="val">${rows.filter(r => r.status === 'monitoring').length}</div></div>
        <div class="tile red"><div class="lbl">Grounding</div>
          <div class="val">${rows.filter(r => r.severity === 'grounding' && r.status !== 'closed').length}</div></div>
        <div class="tile green"><div class="lbl">Closed</div><div class="val">${rows.filter(r => r.status === 'closed').length}</div></div>
      </div>
      <div class="searchbar">
        <div style="flex:1"></div>
        <button class="btn pri" id="df-new">Report a defect</button>
      </div>
      <div class="card"><div class="bd tight"><div class="tblwrap">
        <table class="tbl"><thead><tr>
          <th>#</th><th>Date</th><th>Aircraft</th><th>Category</th><th>Severity</th>
          <th>Description</th><th>Reported by</th><th>Status</th><th></th>
        </tr></thead><tbody>${rows.length ? rows.map(d => `
          <tr>
            <td class="mono">${String(d.defect_no).padStart(4, '0')}</td>
            <td class="nowrap tiny">${fmtDate(d.reported_on)}</td>
            <td><b class="mono">${dash(acOf(A, d.aircraft_id))}</b></td>
            <td class="tiny">${esc(d.category)}</td>
            <td><span class="pill ${d.severity === 'grounding' ? 'red' : d.severity === 'major' ? 'amber' : 'grey'}">${esc(d.severity)}</span></td>
            <td>${esc(d.description)}${d.rectification ? `<div class="tiny muted">Fix: ${esc(d.rectification)}</div>` : ''}</td>
            <td class="tiny">${dash(nameOf(P, d.reported_by))}</td>
            <td><span class="pill ${d.status === 'closed' ? 'green' : d.status === 'monitoring' ? 'amber' : 'red'}">${esc(d.status)}</span></td>
            <td>${admin && d.status !== 'closed' ? `<button class="btn ok sm" data-close-def="${d.id}">Close</button>` : ''}</td>
          </tr>`).join('')
          : `<tr><td colspan="9"><div class="empty"><b>No defects</b><p>Which is the way it should be. Report one the moment something is not right.</p></div></td></tr>`}
        </tbody></table>
      </div></div></div>`;

    $('#df-new').onclick = () => defectForm(A);
    c.onclick = async e => {
      const id = e.target.dataset.closeDef; if (!id) return;
      modal(`
        <div class="mh"><h2>Close defect</h2><button class="x" data-close>&times;</button></div>
        <div class="mb"><div class="field"><label>Rectification</label>
          <textarea class="inp" data-f="rectification" placeholder="What was done to clear it."></textarea></div></div>
        <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn ok" id="cd">Close defect</button></div>`);
      $('#modalbox').onclick = ev => { if (ev.target.closest('[data-close]')) closeModal(); };
      $('#cd').onclick = async () => {
        const d = readForm($('#modalbox'));
        const { error } = await sb.from('crm_defects').update({
          ...d, status: 'closed', closed_by: S.me.id, closed_at: new Date().toISOString()
        }).eq('id', id);
        if (error) return toast(error.message, 'bad');
        closeModal(); toast('Closed', 'good'); go('defects');
      };
    };
  }
});

async function defectForm(A) {
  modal(`
    <div class="mh"><h2>Report a defect</h2><button class="x" data-close>&times;</button></div>
    <div class="mb">
      <div class="row c3">
        <div class="field"><label>Aircraft</label>
          <select class="inp" data-f="aircraft_id">${options(A, 'id', 'identifier', '', '— select —')}</select></div>
        <div class="field"><label>Category</label>
          <select class="inp" data-f="category">${['airframe', 'propulsion', 'battery', 'payload', 'controller', 'software', 'other']
            .map(v => `<option value="${v}">${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select></div>
        <div class="field"><label>Severity</label>
          <select class="inp" data-f="severity">
            <option value="minor">Minor — aircraft remains serviceable</option>
            <option value="major">Major — restricts operation</option>
            <option value="grounding">Grounding — do not fly</option>
          </select></div>
      </div>
      <div class="field"><label>Date noticed</label><input class="inp" type="date" data-f="reported_on" value="${todayISO()}"></div>
      <div class="field"><label>Description</label><textarea class="inp" data-f="description" placeholder="What is wrong, and when it was noticed."></textarea></div>
    </div>
    <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn pri" id="dsave">Report</button></div>`);
  $('#modalbox').onclick = e => { if (e.target.closest('[data-close]')) closeModal(); };
  $('#dsave').onclick = async () => {
    const d = readForm($('#modalbox'));
    if (!d.description) return toast('Describe the defect', 'bad');
    d.reported_by = S.me.id;
    const { error } = await sb.from('crm_defects').insert(d);
    if (error) return toast(error.message, 'bad');
    closeModal(); toast('Defect reported', 'good'); go('defects');
  };
}

/* ---------------------------------------------------------------- */
/* SMS — SAFETY REPORTING                                            */
/* ---------------------------------------------------------------- */
route('sms', {
  title: 'Safety Reporting', group: 'Compliance', icon: 'sms', nav: 'Safety (SMS)',
  sub: 'Hazards, near misses and occurrences',
  render: async (c) => {
    const admin = ['super_admin', 'instructor'].includes(S.me.role);
    const [R, A, P] = await Promise.all([
      q(sb.from('crm_sms_reports').select('*').order('occurred_on', { ascending: false }), 'reports'),
      aircraft(), people()
    ]);
    const rows = R || [];

    c.innerHTML = `
      <div class="card" style="margin-bottom:16px;border-left:3px solid var(--blue)"><div class="bd">
        <b>Just culture.</b> Report anything that did, or nearly did, go wrong. Reports are used to fix the system,
        not to find fault. You can file anonymously — only the safety manager sees who filed a named report.
      </div></div>
      <div class="tiles">
        <div class="tile ${rows.filter(r => r.status === 'open').length ? 'amber' : 'green'}">
          <div class="lbl">Open</div><div class="val">${rows.filter(r => r.status === 'open').length}</div></div>
        <div class="tile"><div class="lbl">Investigating</div><div class="val">${rows.filter(r => r.status === 'investigating').length}</div></div>
        <div class="tile green"><div class="lbl">Closed</div><div class="val">${rows.filter(r => r.status === 'closed').length}</div></div>
        <div class="tile red"><div class="lbl">High or extreme</div>
          <div class="val">${rows.filter(r => ['high', 'extreme'].includes(r.severity)).length}</div></div>
      </div>
      <div class="searchbar"><div style="flex:1"></div><button class="btn pri" id="sf-new">File a report</button></div>
      <div class="card"><div class="bd tight"><div class="tblwrap">
        <table class="tbl"><thead><tr>
          <th>#</th><th>Date</th><th>Type</th><th>Severity</th><th>What happened</th>
          <th>Aircraft</th><th>Reported by</th><th>Status</th><th></th>
        </tr></thead><tbody>${rows.length ? rows.map(r => `
          <tr>
            <td class="mono">${String(r.report_no).padStart(4, '0')}</td>
            <td class="nowrap tiny">${fmtDate(r.occurred_on)}</td>
            <td><span class="pill blue">${esc((r.report_type || '').replace(/_/g, ' '))}</span></td>
            <td><span class="pill ${r.severity === 'extreme' ? 'red' : r.severity === 'high' ? 'red' : r.severity === 'medium' ? 'amber' : 'grey'}">${esc(r.severity)}</span></td>
            <td>${esc(r.description)}${r.corrective_action ? `<div class="tiny muted">Action: ${esc(r.corrective_action)}</div>` : ''}</td>
            <td class="tiny mono">${dash(acOf(A, r.aircraft_id))}</td>
            <td class="tiny">${r.is_anonymous ? '<span class="muted">Anonymous</span>' : dash(nameOf(P, r.reported_by))}</td>
            <td><span class="pill ${r.status === 'closed' ? 'green' : r.status === 'investigating' ? 'amber' : 'red'}">${esc(r.status)}</span></td>
            <td>${admin && r.status !== 'closed' ? `<button class="btn sm" data-sms="${r.id}">Update</button>` : ''}</td>
          </tr>`).join('')
          : `<tr><td colspan="9"><div class="empty"><b>No reports filed</b><p>An empty safety register usually means under-reporting rather than a perfect operation.</p></div></td></tr>`}
        </tbody></table>
      </div></div></div>`;

    $('#sf-new').onclick = () => smsForm(A);
    c.onclick = e => {
      const id = e.target.dataset.sms; if (!id) return;
      smsUpdate(rows.find(r => r.id === id));
    };
  }
});

async function smsForm(A) {
  modal(`
    <div class="mh"><h2>File a safety report</h2><button class="x" data-close>&times;</button></div>
    <div class="mb">
      <div class="row c3">
        <div class="field"><label>Type</label>
          <select class="inp" data-f="report_type">
            <option value="hazard">Hazard — could cause harm</option>
            <option value="near_miss">Near miss</option>
            <option value="incident">Incident</option>
            <option value="accident">Accident</option>
            <option value="occurrence">Other occurrence</option>
          </select></div>
        <div class="field"><label>Severity</label>
          <select class="inp" data-f="severity">
            <option value="low">Low</option><option value="medium">Medium</option>
            <option value="high">High</option><option value="extreme">Extreme</option>
          </select></div>
        <div class="field"><label>Date</label><input class="inp" type="date" data-f="occurred_on" value="${todayISO()}"></div>
      </div>
      <div class="row c2">
        <div class="field"><label>Location</label><input class="inp" data-f="location"></div>
        <div class="field"><label>Aircraft</label>
          <select class="inp" data-f="aircraft_id">${options(A, 'id', 'identifier', '', '— none / not applicable —')}</select></div>
      </div>
      <div class="field"><label>What happened</label><textarea class="inp" data-f="description" style="min-height:110px"></textarea></div>
      <div class="field"><label>Immediate action taken</label><textarea class="inp" data-f="immediate_action"></textarea></div>
      <label class="chk"><input type="checkbox" data-f="is_anonymous"><span>File this anonymously</span></label>
    </div>
    <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn pri" id="ssave">Submit report</button></div>`);
  $('#modalbox').onclick = e => { if (e.target.closest('[data-close]')) closeModal(); };
  $('#ssave').onclick = async () => {
    const d = readForm($('#modalbox'));
    if (!d.description) return toast('Describe what happened', 'bad');
    d.reported_by = S.me.id;   // still stored, but hidden in the list when anonymous
    const { error } = await sb.from('crm_sms_reports').insert(d);
    if (error) return toast(error.message, 'bad');
    closeModal(); toast('Report filed — thank you', 'good'); go('sms');
  };
}

async function smsUpdate(r) {
  modal(`
    <div class="mh"><h2>Report #${String(r.report_no).padStart(4, '0')}</h2><button class="x" data-close>&times;</button></div>
    <div class="mb">
      <p style="margin-top:0"><b>${esc(r.description)}</b></p>
      ${r.immediate_action ? `<p class="tiny muted">Immediate action: ${esc(r.immediate_action)}</p>` : ''}
      <div class="divider"></div>
      <div class="field"><label>Investigation</label><textarea class="inp" data-f="investigation">${esc(r.investigation || '')}</textarea></div>
      <div class="field"><label>Corrective action</label><textarea class="inp" data-f="corrective_action">${esc(r.corrective_action || '')}</textarea></div>
      <div class="field"><label>Status</label>
        <select class="inp" data-f="status">${['open', 'investigating', 'closed']
          .map(s => `<option value="${s}"${r.status === s ? ' selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select></div>
    </div>
    <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn pri" id="su">Save</button></div>`);
  $('#modalbox').onclick = e => { if (e.target.closest('[data-close]')) closeModal(); };
  $('#su').onclick = async () => {
    const d = readForm($('#modalbox'));
    if (d.status === 'closed') { d.closed_by = S.me.id; d.closed_at = new Date().toISOString(); }
    const { error } = await sb.from('crm_sms_reports').update(d).eq('id', r.id);
    if (error) return toast(error.message, 'bad');
    closeModal(); toast('Updated', 'good'); go('sms');
  };
}

/* ---------------------------------------------------------------- */
/* RISK LIBRARY                                                      */
/* ---------------------------------------------------------------- */
route('risk', {
  title: 'Risk Library', group: 'Compliance', icon: 'risk',
  sub: 'Reusable risk assessments',
  render: async (c) => {
    const [RA, RI] = await Promise.all([
      q(sb.from('crm_risk_assessments').select('*').order('created_at', { ascending: false }), 'risk assessments'),
      q(sb.from('crm_risk_items').select('*').order('step_no'), 'risk items')
    ]);
    const list = RA || [], items = RI || [];
    const byRA = {}; items.forEach(i => (byRA[i.assessment_id] = byRA[i.assessment_id] || []).push(i));

    c.innerHTML = `
      <div class="searchbar"><div style="flex:1"></div><button class="btn pri" id="ra-new">New risk assessment</button></div>
      ${list.length ? list.map(ra => {
        const its = byRA[ra.id] || [];
        const worst = its.reduce((w, i) => {
          const b = riskBand(i.l_final ?? i.l_initial, i.c_final ?? i.c_initial);
          return b && (!w || b.r > w.r) ? b : w;
        }, null);
        return `<div class="card" style="margin-bottom:14px">
          <div class="hd">
            <h3>${esc(ra.title)}</h3>
            <span class="pill grey">v${ra.version}</span>
            ${ra.applicability ? `<span class="pill blue">${esc(ra.applicability)}</span>` : ''}
            ${worst ? `<span class="pill ${worst.pill}">Highest residual: ${worst.r} ${worst.label}</span>` : ''}
            <div style="flex:1"></div>
            <button class="btn sm" data-editra="${ra.id}">Edit hazards</button>
          </div>
          <div class="bd tight"><div class="tblwrap"><table class="tbl" style="min-width:820px">
            <thead><tr><th>#</th><th>Hazard</th><th>Consequence</th><th>Existing controls</th>
              <th>Initial</th><th>Additional controls</th><th>Residual</th></tr></thead>
            <tbody>${its.length ? its.map(i => {
              const a = riskBand(i.l_initial, i.c_initial), b = riskBand(i.l_final, i.c_final);
              return `<tr>
                <td class="mono">${String(i.step_no).padStart(3, '0')}</td>
                <td><b>${esc(i.title)}</b>${i.the_risk ? `<div class="tiny muted">${esc(i.the_risk)}</div>` : ''}</td>
                <td class="tiny">${dash(i.the_consequence)}</td>
                <td class="tiny">${dash(i.existing_controls)}</td>
                <td>${a ? `<span class="pill ${a.pill}">${a.r} ${a.label}</span>` : '—'}</td>
                <td class="tiny">${dash(i.additional_controls)}</td>
                <td>${b ? `<span class="pill ${b.pill}">${b.r} ${b.label}</span>` : '—'}</td>
              </tr>`; }).join('')
              : '<tr><td colspan="7"><div class="empty tiny">No hazards listed yet.</div></td></tr>'}
            </tbody>
          </table></div></div>
        </div>`; }).join('')
        : `<div class="card"><div class="bd empty"><b>No risk assessments yet</b>
             <p>Build one per operation type — Sub-25 kg training, survey, agricultural spray — then attach it to jobs.</p>
             <button class="btn pri" id="ra-new2">Create the first one</button></div></div>`}`;

    const newRA = async () => {
      modal(`
        <div class="mh"><h2>New risk assessment</h2><button class="x" data-close>&times;</button></div>
        <div class="mb">
          <div class="field"><label>Title</label><input class="inp" data-f="title" placeholder="RePL Sub-25 kg training"></div>
          <div class="field"><label>Applicability</label><input class="inp" data-f="applicability" placeholder="RePL Sub 25kg"></div>
          <div class="field"><label>Authority</label><input class="inp" data-f="authority" placeholder="Chief Remote Pilot"></div>
        </div>
        <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn pri" id="rasave">Create</button></div>`);
      $('#modalbox').onclick = e => { if (e.target.closest('[data-close]')) closeModal(); };
      $('#rasave').onclick = async () => {
        const d = readForm($('#modalbox'));
        if (!d.title) return toast('Give it a title', 'bad');
        d.created_by = S.me.id;
        const { data, error } = await sb.from('crm_risk_assessments').insert(d).select('id').maybeSingle();
        if (error) return toast(error.message, 'bad');
        closeModal(); riskItems(data.id);
      };
    };
    if ($('#ra-new'))  $('#ra-new').onclick  = newRA;
    if ($('#ra-new2')) $('#ra-new2').onclick = newRA;
    c.onclick = e => { const id = e.target.dataset.editra; if (id) riskItems(id); };
  }
});

async function riskItems(raId) {
  let items = await q(sb.from('crm_risk_items').select('*').eq('assessment_id', raId).order('step_no'), 'hazards') || [];
  if (!items.length) items = [{ step_no: 1, title: '' }];

  function paint() {
    modal(`
      <div class="mh"><h2>Hazards and controls</h2><button class="x" data-close>&times;</button></div>
      <div class="mb" id="ribody"></div>
      <div class="mf">
        <button class="btn" id="riadd">+ Add hazard</button>
        <div style="flex:1"></div>
        <button class="btn ghost" data-close>Cancel</button>
        <button class="btn pri" id="risave">Save all</button>
      </div>`, { wide: true, noFocus: true });

    $('#ribody').innerHTML = items.map((it, i) => {
      const a = riskBand(it.l_initial, it.c_initial), b = riskBand(it.l_final, it.c_final);
      const sel = (f, v) => `<select class="inp" data-ri="${i}" data-k="${f}">
        ${[0, 1, 2, 3, 4, 5].map(n => `<option value="${n}"${Number(v) === n ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
      return `<div class="card" style="margin-bottom:12px"><div class="bd">
        <div class="between" style="margin-bottom:9px">
          <b>Hazard ${it.step_no || i + 1}</b>
          <button class="btn ghost sm" data-delri="${i}">Remove</button>
        </div>
        <div class="field"><label>Title</label>
          <input class="inp" data-ri="${i}" data-k="title" value="${esc(it.title || '')}" placeholder="Airspace incursion from other aviation assets"></div>
        <div class="row c2">
          <div class="field"><label>The risk</label><textarea class="inp" data-ri="${i}" data-k="the_risk">${esc(it.the_risk || '')}</textarea></div>
          <div class="field"><label>The consequence</label><textarea class="inp" data-ri="${i}" data-k="the_consequence">${esc(it.the_consequence || '')}</textarea></div>
        </div>
        <div class="field"><label>Existing controls</label>
          <textarea class="inp" data-ri="${i}" data-k="existing_controls">${esc(it.existing_controls || '')}</textarea></div>
        <div class="row c3" style="align-items:end">
          <div class="field"><label>Likelihood (initial)</label>${sel('l_initial', it.l_initial)}</div>
          <div class="field"><label>Consequence (initial)</label>${sel('c_initial', it.c_initial)}</div>
          <div class="field"><label>Rating</label>
            <div>${a ? `<span class="pill ${a.pill}">${a.r} — ${a.label}</span>` : '<span class="muted tiny">set both</span>'}</div></div>
        </div>
        <div class="field"><label>Additional controls</label>
          <textarea class="inp" data-ri="${i}" data-k="additional_controls">${esc(it.additional_controls || '')}</textarea></div>
        <div class="row c3" style="align-items:end">
          <div class="field"><label>Likelihood (residual)</label>${sel('l_final', it.l_final)}</div>
          <div class="field"><label>Consequence (residual)</label>${sel('c_final', it.c_final)}</div>
          <div class="field"><label>Residual rating</label>
            <div>${b ? `<span class="pill ${b.pill}">${b.r} — ${b.label}</span>` : '<span class="muted tiny">set both</span>'}</div></div>
        </div>
        ${b && b.r >= 6 ? `<p class="tiny" style="color:var(--red);margin:6px 0 0">
          Residual risk is ${b.label}. The task is not permitted until further controls bring it down.</p>` : ''}
      </div></div>`;
    }).join('');

    $('#ribody').oninput = $('#ribody').onchange = e => {
      const i = e.target.dataset.ri, k = e.target.dataset.k;
      if (i === undefined || !k) return;
      items[i][k] = e.target.tagName === 'SELECT' ? Number(e.target.value) : e.target.value;
      if (['l_initial', 'c_initial', 'l_final', 'c_final'].includes(k)) paint();
    };
    $('#ribody').onclick = e => {
      const i = e.target.dataset.delri; if (i === undefined) return;
      items.splice(i, 1); if (!items.length) items = [{ step_no: 1, title: '' }]; paint();
    };
    $('#riadd').onclick = () => { items.push({ step_no: items.length + 1, title: '' }); paint(); };
    $('#risave').onclick = async () => {
      await sb.from('crm_risk_items').delete().eq('assessment_id', raId);
      const clean = items.filter(x => x.title).map((x, n) => ({
        assessment_id: raId, step_no: n + 1, title: x.title,
        the_risk: x.the_risk || null, the_consequence: x.the_consequence || null,
        existing_controls: x.existing_controls || null, additional_controls: x.additional_controls || null,
        l_initial: x.l_initial ?? null, c_initial: x.c_initial ?? null,
        l_final: x.l_final ?? null, c_final: x.c_final ?? null
      }));
      if (clean.length) {
        const { error } = await sb.from('crm_risk_items').insert(clean);
        if (error) return toast(error.message, 'bad');
      }
      closeModal(); toast('Saved', 'good'); go('risk');
    };
    $('#modalbox').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(); });
  }
  paint();
}

/* ---------------------------------------------------------------- */
/* DOCUMENTS                                                         */
/* ---------------------------------------------------------------- */
route('docs', {
  title: 'Documents', group: 'Compliance', icon: 'docs',
  sub: 'Operations manual, checklists and forms',
  render: async (c) => {
    const admin = ['super_admin', 'instructor'].includes(S.me.role);
    const D = await q(sb.from('crm_documents').select('*').order('category').order('title'), 'documents') || [];
    const groups = {};
    D.forEach(d => (groups[d.category || 'general'] = groups[d.category || 'general'] || []).push(d));

    c.innerHTML = `
      ${admin ? '<div class="searchbar"><div style="flex:1"></div><button class="btn pri" id="dc-new">Add document</button></div>' : ''}
      ${Object.keys(groups).length ? Object.entries(groups).map(([g, list]) => `
        <div class="card" style="margin-bottom:14px">
          <div class="hd"><h3>${esc(g.replace(/_/g, ' ').replace(/\b\w/g, m => m.toUpperCase()))}</h3></div>
          <div class="bd tight">${list.map(d => `
            <div class="listitem between">
              <div><a href="${esc(d.url)}" target="_blank" rel="noopener"><b>${esc(d.title)}</b></a>
                <div class="tiny muted">${d.version ? 'v' + esc(d.version) + ' · ' : ''}${d.effective_on ? 'effective ' + fmtDate(d.effective_on) : ''}</div></div>
              <div class="actions">
                <span class="pill grey">${esc(d.visible_to)}</span>
                ${admin ? `<button class="btn ghost sm" data-deldoc="${d.id}">&times;</button>` : ''}
              </div>
            </div>`).join('')}</div>
        </div>`).join('')
        : `<div class="card"><div class="bd empty"><b>No documents yet</b>
             <p>Link the operations manual, pre-flight checklists and CAAN forms here so crew always reach the current version.</p>
             ${admin ? '<button class="btn pri" id="dc-new2">Add the first document</button>' : ''}</div></div>`}`;

    const add = () => {
      modal(`
        <div class="mh"><h2>Add document</h2><button class="x" data-close>&times;</button></div>
        <div class="mb">
          <div class="field"><label>Title</label><input class="inp" data-f="title"></div>
          <div class="field"><label>Link</label><input class="inp" data-f="url" placeholder="https://drive.google.com/…">
            <div class="hint">Set Google Drive sharing to “anyone with the link can view”.</div></div>
          <div class="row c3">
            <div class="field"><label>Category</label>
              <select class="inp" data-f="category">${['ops_manual', 'checklist', 'regulation', 'form', 'training', 'general']
                .map(v => `<option value="${v}">${v.replace(/_/g, ' ')}</option>`).join('')}</select></div>
            <div class="field"><label>Version</label><input class="inp" data-f="version"></div>
            <div class="field"><label>Effective from</label><input class="inp" type="date" data-f="effective_on"></div>
          </div>
          <div class="field"><label>Visible to</label>
            <select class="inp" data-f="visible_to">
              <option value="all">Everyone signed in</option>
              <option value="staff">Staff and pilots</option>
              <option value="admin">Administrators only</option>
            </select></div>
        </div>
        <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn pri" id="dcs">Save</button></div>`);
      $('#modalbox').onclick = e => { if (e.target.closest('[data-close]')) closeModal(); };
      $('#dcs').onclick = async () => {
        const d = readForm($('#modalbox'));
        if (!d.title || !d.url) return toast('Title and link are required', 'bad');
        const { error } = await sb.from('crm_documents').insert(d);
        if (error) return toast(error.message, 'bad');
        closeModal(); toast('Added', 'good'); go('docs');
      };
    };
    if ($('#dc-new'))  $('#dc-new').onclick  = add;
    if ($('#dc-new2')) $('#dc-new2').onclick = add;
    c.onclick = async e => {
      const id = e.target.dataset.deldoc; if (!id) return;
      if (!await confirmBox('Remove this document?', 'The link will be removed from the library.', 'Remove')) return;
      await sb.from('crm_documents').delete().eq('id', id);
      toast('Removed', 'good'); go('docs');
    };
  }
});

/* ---------------------------------------------------------------- */
/* PEOPLE (admin)                                                    */
/* ---------------------------------------------------------------- */
route('people', {
  title: 'People', group: 'Administration', icon: 'ppl',
  roles: ['super_admin'],
  sub: 'Roles, access and bases',
  render: async (c) => {
    const P = await people(true);
    c.innerHTML = `
      <div class="card" style="margin-bottom:16px;border-left:3px solid var(--blue)"><div class="bd">
        Anyone can create an account, and sees nothing until you give them a role here.
        <b>Student</b> and <b>pilot</b> see only their own records; <b>instructor</b> can approve jobs and
        see everyone's; <b>super admin</b> can do everything including changing roles.
      </div></div>
      <div class="card"><div class="bd tight"><div class="tblwrap">
        <table class="tbl"><thead><tr>
          <th>Name</th><th>Email</th><th>Role</th><th>Base</th><th>Active</th><th></th>
        </tr></thead><tbody>${P.map(p => `
          <tr>
            <td><b>${esc(p.full_name)}</b>${p.id === S.me.id ? ' <span class="pill grey">you</span>' : ''}</td>
            <td class="tiny">${dash(p.email)}</td>
            <td><span class="pill ${p.role === 'super_admin' ? 'crim' : p.role === 'instructor' ? 'blue' : 'grey'}">${esc(p.role.replace('_', ' '))}</span></td>
            <td class="tiny">${dash(p.base)}</td>
            <td>${p.is_active ? '<span class="pill green">Active</span>' : '<span class="pill red">Disabled</span>'}</td>
            <td><button class="btn sm" data-editp="${p.id}">Edit</button></td>
          </tr>`).join('')}</tbody></table>
      </div></div></div>`;
    c.onclick = e => {
      const id = e.target.dataset.editp; if (!id) return;
      personForm(P.find(x => x.id === id));
    };
  }
});

async function personForm(p) {
  modal(`
    <div class="mh"><h2>${esc(p.full_name)}</h2><button class="x" data-close>&times;</button></div>
    <div class="mb">
      <div class="row c2">
        <div class="field"><label>Full name</label><input class="inp" data-f="full_name" value="${esc(p.full_name || '')}"></div>
        <div class="field"><label>Role</label>
          <select class="inp" data-f="role">${[['student', 'Student'], ['pilot', 'Pilot'], ['instructor', 'Instructor'], ['super_admin', 'Super admin']]
            .map(([v, l]) => `<option value="${v}"${p.role === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <div class="row c2">
        <div class="field"><label>Base</label>
          <select class="inp" data-f="base">${Object.keys(BASES).map(b => `<option${p.base === b ? ' selected' : ''}>${b}</option>`).join('')}</select></div>
        <div class="field"><label>Phone</label><input class="inp" data-f="phone" value="${esc(p.phone || '')}"></div>
      </div>
      <div class="row c2">
        <div class="field"><label>ARN (CASA)</label><input class="inp" data-f="arn" value="${esc(p.arn || '')}"></div>
        <div class="field"><label>CAAN licence</label><input class="inp" data-f="caan_licence" value="${esc(p.caan_licence || '')}"></div>
      </div>
      <label class="chk"><input type="checkbox" data-f="is_active"${p.is_active ? ' checked' : ''}><span>Account active</span></label>
    </div>
    <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn pri" id="psave">Save</button></div>`);
  $('#modalbox').onclick = e => { if (e.target.closest('[data-close]')) closeModal(); };
  $('#psave').onclick = async () => {
    const d = readForm($('#modalbox'));
    const { error } = await sb.from('crm_people').update(d).eq('id', p.id);
    if (error) return toast(error.message, 'bad');
    closeModal(); toast('Saved', 'good'); S.cache.people = null; go('people');
  };
}

/* ---------------------------------------------------------------- */
/* CLIENTS & NOTICES (admin)                                         */
/* ---------------------------------------------------------------- */
route('clients', {
  title: 'Clients', group: 'Administration', icon: 'ppl',
  roles: ['super_admin', 'instructor'],
  sub: 'Who the work is for',
  render: async (c) => {
    const CL = await clients(true);
    c.innerHTML = `
      <div class="searchbar"><div style="flex:1"></div><button class="btn pri" id="cl-new">Add client</button></div>
      <div class="card"><div class="bd tight"><div class="tblwrap">
        <table class="tbl"><thead><tr><th>Name</th><th>Contact</th><th>Email</th><th>Phone</th><th></th></tr></thead>
        <tbody>${CL.length ? CL.map(x => `
          <tr><td><b>${esc(x.name)}</b></td><td class="tiny">${dash(x.contact_name)}</td>
            <td class="tiny">${dash(x.email)}</td><td class="tiny">${dash(x.phone)}</td>
            <td><button class="btn sm" data-editcl="${x.id}">Edit</button></td></tr>`).join('')
          : `<tr><td colspan="5"><div class="empty"><b>No clients yet</b><p>Add the organisations you fly for so jobs can be attributed.</p></div></td></tr>`}
        </tbody></table>
      </div></div></div>`;
    const form = row => {
      const x = row || {};
      modal(`
        <div class="mh"><h2>${row ? 'Edit' : 'Add'} client</h2><button class="x" data-close>&times;</button></div>
        <div class="mb">
          <div class="field"><label>Name</label><input class="inp" data-f="name" value="${esc(x.name || '')}"></div>
          <div class="row c2">
            <div class="field"><label>Contact</label><input class="inp" data-f="contact_name" value="${esc(x.contact_name || '')}"></div>
            <div class="field"><label>Phone</label><input class="inp" data-f="phone" value="${esc(x.phone || '')}"></div>
          </div>
          <div class="field"><label>Email</label><input class="inp" data-f="email" value="${esc(x.email || '')}"></div>
          <div class="field"><label>Address</label><textarea class="inp" data-f="address">${esc(x.address || '')}</textarea></div>
        </div>
        <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn pri" id="cls">Save</button></div>`);
      $('#modalbox').onclick = e => { if (e.target.closest('[data-close]')) closeModal(); };
      $('#cls').onclick = async () => {
        const d = readForm($('#modalbox'));
        if (!d.name) return toast('Name is required', 'bad');
        const res = row ? await sb.from('crm_clients').update(d).eq('id', row.id)
                        : await sb.from('crm_clients').insert(d);
        if (res.error) return toast(res.error.message, 'bad');
        closeModal(); toast('Saved', 'good'); S.cache.clients = null; go('clients');
      };
    };
    $('#cl-new').onclick = () => form(null);
    c.onclick = e => { const id = e.target.dataset.editcl; if (id) form(CL.find(x => x.id === id)); };
  }
});

route('notices', {
  title: 'Notices', group: 'Administration', icon: 'docs',
  roles: ['super_admin', 'instructor'],
  sub: 'Post to crew and students',
  render: async (c) => {
    const N = await q(sb.from('crm_notices').select('*').order('created_at', { ascending: false }), 'notices') || [];
    c.innerHTML = `
      <div class="searchbar"><div style="flex:1"></div><button class="btn pri" id="n-new">Post a notice</button></div>
      <div class="card"><div class="bd tight">
        ${N.length ? N.map(n => `
          <div class="listitem between" style="align-items:flex-start">
            <div><b>${esc(n.title)}</b>
              <div class="tiny muted">${fmtDate(n.created_at)} · to ${esc(n.audience)}</div>
              ${n.body ? `<p style="margin:6px 0 0;font-size:13px">${esc(n.body)}</p>` : ''}</div>
            <div class="actions">
              ${n.urgency !== 'normal' ? `<span class="pill ${n.urgency === 'urgent' ? 'red' : 'amber'}">${esc(n.urgency)}</span>` : ''}
              <button class="btn ghost sm" data-deln="${n.id}">&times;</button></div>
          </div>`).join('')
        : '<div class="empty"><b>Nothing posted</b><p>Notices appear on everyone’s dashboard.</p></div>'}
      </div></div>`;
    $('#n-new').onclick = () => {
      modal(`
        <div class="mh"><h2>Post a notice</h2><button class="x" data-close>&times;</button></div>
        <div class="mb">
          <div class="field"><label>Title</label><input class="inp" data-f="title"></div>
          <div class="field"><label>Body</label><textarea class="inp" data-f="body" style="min-height:110px"></textarea></div>
          <div class="row c3">
            <div class="field"><label>Audience</label>
              <select class="inp" data-f="audience"><option value="all">Everyone</option>
                <option value="pilots">Pilots</option><option value="students">Students</option>
                <option value="staff">Staff</option></select></div>
            <div class="field"><label>Urgency</label>
              <select class="inp" data-f="urgency"><option value="normal">Normal</option>
                <option value="important">Important</option><option value="urgent">Urgent</option></select></div>
            <div class="field"><label>Expires</label><input class="inp" type="date" data-f="expires_on"></div>
          </div>
        </div>
        <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn pri" id="ns">Post</button></div>`);
      $('#modalbox').onclick = e => { if (e.target.closest('[data-close]')) closeModal(); };
      $('#ns').onclick = async () => {
        const d = readForm($('#modalbox'));
        if (!d.title) return toast('Give it a title', 'bad');
        d.posted_by = S.me.id;
        const { error } = await sb.from('crm_notices').insert(d);
        if (error) return toast(error.message, 'bad');
        closeModal(); toast('Posted', 'good'); go('notices');
      };
    };
    c.onclick = async e => {
      const id = e.target.dataset.deln; if (!id) return;
      await sb.from('crm_notices').delete().eq('id', id);
      toast('Removed', 'good'); go('notices');
    };
  }
});

/* ---------------------------------------------------------------- */
/* MY PROFILE                                                        */
/* ---------------------------------------------------------------- */
route('me', {
  title: 'My Profile', group: 'Administration', icon: 'me',
  sub: 'Your details and this device',
  render: async (c) => {
    const p = S.me;
    c.innerHTML = `
      <div class="grid2">
        <div class="card"><div class="hd"><h3>Details</h3></div><div class="bd">
          <div class="row c2">
            <div class="field"><label>Full name</label><input class="inp" data-f="full_name" value="${esc(p.full_name || '')}"></div>
            <div class="field"><label>Phone</label><input class="inp" data-f="phone" value="${esc(p.phone || '')}"></div>
          </div>
          <div class="row c2">
            <div class="field"><label>Base</label>
              <select class="inp" data-f="base">${Object.keys(BASES).map(b => `<option${p.base === b ? ' selected' : ''}>${b}</option>`).join('')}</select>
              <div class="hint">Sets first light, last light and the weather station.</div></div>
            <div class="field"><label>Emergency contact</label><input class="inp" data-f="emergency_contact" value="${esc(p.emergency_contact || '')}"></div>
          </div>
          <div class="row c2">
            <div class="field"><label>ARN (CASA)</label><input class="inp" data-f="arn" value="${esc(p.arn || '')}"></div>
            <div class="field"><label>CAAN licence</label><input class="inp" data-f="caan_licence" value="${esc(p.caan_licence || '')}"></div>
          </div>
          <button class="btn pri" id="me-save">Save</button>
        </div></div>

        <div class="stack">
          <div class="card"><div class="hd"><h3>Account</h3></div><div class="bd">
            <dl class="kv">
              <dt>Email</dt><dd>${esc(p.email || '')}</dd>
              <dt>Role</dt><dd><span class="pill ${p.role === 'super_admin' ? 'crim' : 'blue'}">${esc(p.role.replace('_', ' '))}</span></dd>
              <dt>Joined</dt><dd>${fmtDate(p.created_at)}</dd>
            </dl>
            <div class="divider"></div>
            <button class="btn" id="me-pass">Change password</button>
          </div></div>
          <div class="card"><div class="hd"><h3>Install on your phone</h3></div><div class="bd">
            <p style="margin-top:0">On iPhone, open this page in Safari, tap Share, then <b>Add to Home Screen</b>.
              On Android, tap the browser menu and <b>Install app</b>. It then opens full screen like any other app.</p>
          </div></div>
        </div>
      </div>`;
    $('#me-save').onclick = async () => {
      const d = readForm(c);
      const { error } = await sb.from('crm_people').update(d).eq('id', p.id);
      if (error) return toast(error.message, 'bad');
      Object.assign(S.me, d); S.cache.people = null;
      paintMe(); toast('Saved', 'good'); go('me');
    };
    $('#me-pass').onclick = async () => {
      modal(`
        <div class="mh"><h2>Change password</h2><button class="x" data-close>&times;</button></div>
        <div class="mb"><div class="field"><label>New password</label>
          <input class="inp" type="password" id="np" placeholder="At least 6 characters"></div></div>
        <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn pri" id="pw">Update</button></div>`);
      $('#modalbox').onclick = e => { if (e.target.closest('[data-close]')) closeModal(); };
      $('#pw').onclick = async () => {
        const v = $('#np').value;
        if (!v || v.length < 6) return toast('At least 6 characters', 'bad');
        const { error } = await sb.auth.updateUser({ password: v });
        if (error) return toast(error.message, 'bad');
        closeModal(); toast('Password updated', 'good');
      };
    };
  }
});

/* ---------------------------------------------------------------- */
/* 7. GLOBAL EVENTS & BOOT                                           */
/* ---------------------------------------------------------------- */
function paintMe() {
  $('#me-name').textContent = S.me.full_name || '';
  $('#me-role').textContent = (S.me.role || '').replace('_', ' ');
  $('#me-av').textContent   = initials(S.me.full_name);
  $('#sf-base').textContent = S.me.base || '';
}

function tickClock() {
  const now = new Date();
  const tz = (BASES[S.me?.base] || {}).tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('#clk-utc').textContent = hhmm(now, 'UTC');
  $('#clk-loc').textContent = hhmm(now, tz);
  $('#clk-tz').textContent  = (tz || '').split('/').pop().replace(/_/g, ' ');
}

document.addEventListener('click', e => {
  const goBtn = e.target.closest('[data-go]');
  if (goBtn) { go(goBtn.dataset.go); return; }
  const job = e.target.closest('[data-job]');
  if (job) { go('jobs', job.dataset.job); return; }
  if (e.target.closest('[data-newjob]')) { jobWizard(null); return; }
  const ed = e.target.closest('[data-editjob]');
  if (ed) { jobWizard(ed.dataset.editjob); return; }
  const sign = e.target.closest('[data-sign]');
  if (sign) { signJob(sign.dataset.sign); return; }
  const lf = e.target.closest('[data-logflight]');
  if (lf) { flightForm(lf.dataset.logflight); return; }
  const act = e.target.closest('[data-act]');
  if (act) {
    const { act: a, id } = act.dataset;
    if (a === 'sendback') {
      modal(`
        <div class="mh"><h2>Send back for revision</h2><button class="x" data-close>&times;</button></div>
        <div class="mb"><div class="field"><label>What needs fixing?</label>
          <textarea class="inp" id="rn" placeholder="The pilot will see this."></textarea></div></div>
        <div class="mf"><button class="btn ghost" data-close>Cancel</button><button class="btn dang" id="sbk">Send back</button></div>`);
      $('#modalbox').onclick = ev => { if (ev.target.closest('[data-close]')) closeModal(); };
      $('#sbk').onclick = async () => {
        const { error } = await sb.from('crm_jobs').update({ status: 'resubmit', review_note: $('#rn').value }).eq('id', id);
        if (error) return toast(error.message, 'bad');
        closeModal(); toast('Sent back', 'good'); go('jobs', id);
      };
      return;
    }
    jobAction(id, a);
  }
});

$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
$('#burger').onclick = () => { $('#sidebar').classList.toggle('open'); $('#scrim').classList.toggle('on'); };
$('#scrim').onclick  = () => { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('on'); };
$('#signout').onclick = async () => { await sb.auth.signOut(); location.reload(); };
window.addEventListener('hashchange', () => {
  const [k, p] = location.hash.slice(1).split('/');
  if (k && k !== S.route) go(k, p);
});
window.addEventListener('online',  () => $('#offbar').classList.remove('on'));
window.addEventListener('offline', () => $('#offbar').classList.add('on'));

/* The boot screen must never be a dead end. Anything that goes wrong
   during start-up gets shown here with a way out, rather than leaving
   the spinner turning forever. */
function bootFail(title, detail, showLogin) {
  const b = $('#boot');
  if (!b || b.hidden) return;
  b.innerHTML = `<div class="mark" style="max-width:360px;padding:0 20px">
    <div style="font-size:22px;font-weight:800;letter-spacing:-.02em">EASTERN <span style="color:#DC143C">UAV</span></div>
    <b style="display:block;margin-top:18px;font-size:15px">${esc(title)}</b>
    <p style="color:#8fa6c2;font-size:13px;line-height:1.55;margin:8px 0 16px">${esc(detail)}</p>
    <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
      <button class="btn" id="bf-reload">Reload</button>
      ${showLogin ? '<button class="btn" id="bf-signout">Sign in again</button>' : ''}
    </div></div>`;
  S.booted = true;
  const r = $('#bf-reload'); if (r) r.onclick = () => location.reload();
  const s = $('#bf-signout');
  if (s) s.onclick = async () => {
    try { await sb.auth.signOut(); } catch (e) {}
    try { Object.keys(localStorage).filter(k => k.startsWith('sb-')).forEach(k => localStorage.removeItem(k)); } catch (e) {}
    location.reload();
  };
}

/* If nothing has resolved after 20 seconds, something is wrong that we
   are not being told about — a paused project waking up, or no network. */
const bootWatchdog = setTimeout(() => {
  bootFail('This is taking longer than it should',
           'The database may be waking up from idle, or the connection dropped. Reload to try again.',
           true);
}, 20000);

async function start() {
  let data;
  try {
    ({ data } = await sb.auth.getSession());
  } catch (err) {
    clearTimeout(bootWatchdog);
    return bootFail('Could not reach the sign-in service',
                    (err && err.message) || 'Check your connection and reload.', true);
  }
  S.session = data && data.session;
  if (!S.session) {
    clearTimeout(bootWatchdog);
    $('#boot').hidden = true;
    $('#login').hidden = false;
    paintLogin();
    S.booted = true;
    return;
  }

  let meErr = null;
  try { await loadMe(); } catch (err) { meErr = err; }
  clearTimeout(bootWatchdog);

  if (!S.me) {
    return bootFail('Could not load your profile',
      meErr ? (meErr.message || String(meErr))
            : 'Your account exists but has no record in the CRM. Run CRM-SCHEMA.sql in Supabase, then reload.',
      true);
  }
  buildNav();
  paintMe();
  tickClock();
  setInterval(tickClock, 20000);
  $('#login').hidden = true;
  $('#boot').hidden = true;
  $('#app').classList.add('on');
  if (!navigator.onLine) $('#offbar').classList.add('on');
  S.booted = true;
  const [k, p] = location.hash.slice(1).split('/');
  go(k && ROUTES[k] ? k : 'dashboard', p);
}

/* Do not touch the page until the first start() has settled.
   supabase-js replays INITIAL_SESSION and SIGNED_IN for a session it
   restored from storage, so reloading on those sends the page into an
   endless reload loop: restore -> SIGNED_IN -> reload -> restore ...
   Once booted, a SIGNED_IN can only mean a real new sign-in. */
sb.auth.onAuthStateChange((event) => {
  if (!S.booted) return;
  if (event === 'SIGNED_OUT') { location.reload(); return; }
  if (event === 'SIGNED_IN' && !S.me) location.reload();
});

wireLogin();
start().catch(err => {
  clearTimeout(bootWatchdog);
  bootFail('Something went wrong starting up', (err && err.message) || String(err), true);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
