// ── GEMMA · FINANCES TAB ──
// Code only. No financial data lives in this file or this repo.
// Data is stored by the private "gemma-finance" Cloudflare Worker, behind Google sign-in
// (ashley@cognitivenursing.io only), and is never cached in this browser.
(function () {
  'use strict';

  const FIN_API         = 'https://gemma-finance.ashley-57c.workers.dev';
  const FIN_SESSION_KEY = 'gemma_finance_session';
  const FIN_BLUR_KEY    = 'gemma_finance_blur';
  const FIN_ALLOWED     = 'ashley@cognitivenursing.io';

  const CATS = ['Housing', 'Utilities', 'Insurance', 'Food', 'Transportation', 'Phone & internet', 'Subscriptions', 'Personal', 'Giving', 'Other'];
  const SHIFT_DEST = ['Savings', 'Debt', 'Spending', 'Undecided'];

  function template() {
    return {
      budget: {
        income: [
          { name: 'CCCC take-home pay', amount: null },
          { name: 'CCH: 2 scheduled shifts (take-home)', amount: null }
        ],
        expenses: [
          { name: 'Mortgage', cat: 'Housing', amount: null },
          { name: 'Electric', cat: 'Utilities', amount: null },
          { name: 'Water / sewer', cat: 'Utilities', amount: null },
          { name: 'Phone', cat: 'Phone & internet', amount: null },
          { name: 'Internet', cat: 'Phone & internet', amount: null },
          { name: 'Auto insurance', cat: 'Insurance', amount: null },
          { name: 'Homeowners insurance', cat: 'Insurance', amount: null },
          { name: 'Groceries', cat: 'Food', amount: null },
          { name: 'Fuel', cat: 'Transportation', amount: null },
          { name: 'Subscriptions', cat: 'Subscriptions', amount: null }
        ]
      },
      extraShifts: [],
      debts: [
        { name: 'Camper loan', lender: '', balance: null, rate: null, payment: null, inBudget: true },
        { name: 'Truck loan', lender: '', balance: null, rate: null, payment: null, inBudget: true },
        { name: 'Jeep loan', lender: '', balance: null, rate: null, payment: null, inBudget: true },
        { name: 'Credit card', lender: '', balance: null, rate: null, payment: null, inBudget: true }
      ],
      savings: { goal: null, targetDate: '', entries: [] }
    };
  }

  // ── state ──
  let finSession = null, data = null, updatedAt = null;
  let saveTimer = null, saving = false, dirty = false, loaded = false, loading = false;
  let blurred = true;

  function loadFinSession() {
    try {
      const s = JSON.parse(localStorage.getItem(FIN_SESSION_KEY) || 'null');
      if (s && s.token && s.exp > Date.now() + 60000 && s.email === FIN_ALLOWED) return s;
    } catch (e) {}
    return null;
  }
  try { const b = localStorage.getItem(FIN_BLUR_KEY); if (b !== null) blurred = b === '1'; } catch (e) {}

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function num(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  function $$(n) { return money.format(n || 0); }
  function monthLabel(d) { return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }); }
  function addMonths(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), 1); x.setMonth(x.getMonth() + n); return x; }

  function setStatus(msg, kind) {
    const el = $('finStatus'); if (!el) return;
    el.textContent = msg; el.dataset.kind = kind || '';
  }

  // ── API ──
  async function api(path, opts) {
    opts = opts || {};
    const r = await fetch(FIN_API + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (finSession ? finSession.token : '') },
      body: opts.body
    });
    const body = await r.json().catch(() => ({}));
    if (r.status === 401) { finSession = null; try { localStorage.removeItem(FIN_SESSION_KEY); } catch (e) {} }
    return { ok: r.ok, status: r.status, body };
  }

  // Called by Gemma's sign-in with the Google credential
  async function financeAuth(credential) {
    try {
      const r = await fetch(FIN_API + '/auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { if (isOpen()) renderGate(d.error || ('Sign-in failed (' + r.status + ')')); return; }
      finSession = d;
      try { localStorage.setItem(FIN_SESSION_KEY, JSON.stringify(d)); } catch (e) {}
      if (isOpen()) loadData();
    } catch (e) {
      if (isOpen()) renderGate('Could not reach the finance server. Has the gemma-finance Worker been set up?');
    }
  }

  function financeSignOut() {
    finSession = null; data = null; updatedAt = null; loaded = false; dirty = false;
    clearTimeout(saveTimer);
    try { localStorage.removeItem(FIN_SESSION_KEY); } catch (e) {}
    const ws = $('financeWorkspace'); if (ws) ws.innerHTML = '';
  }

  function isOpen() { const p = $('panel-finance'); return p && p.classList.contains('active'); }

  function financeOpen() {
    if (!finSession) finSession = loadFinSession();
    if (!finSession) { renderGate(''); return; }
    if (!loaded) loadData(); else render();
  }

  async function loadData() {
    if (loading) return;
    loading = true;
    const ws = $('financeWorkspace');
    ws.innerHTML = '<div class="fin-loading">Loading your finances…</div>';
    try {
      const r = await api('/data');
      if (r.status === 401) { renderGate('Your finance sign-in expired. Sign in again.'); return; }
      if (!r.ok) { renderGate(r.body.error || ('Could not load (' + r.status + ')')); return; }
      if (r.body && r.body.data) { data = normalize(r.body.data); updatedAt = r.body.updatedAt; }
      else { data = template(); updatedAt = null; }
      loaded = true; dirty = false;
      render();
      setStatus(updatedAt ? 'Saved ' + new Date(updatedAt).toLocaleString() : 'New. Nothing saved yet', 'ok');
    } catch (e) {
      renderGate('Could not reach the finance server. Has the gemma-finance Worker been set up?');
    } finally { loading = false; }
  }

  function normalize(d) {
    const t = template();
    d = d || {};
    d.budget = d.budget || t.budget;
    d.budget.income = d.budget.income || [];
    d.budget.expenses = d.budget.expenses || [];
    d.extraShifts = d.extraShifts || [];
    d.debts = d.debts || [];
    d.savings = Object.assign({ goal: null, targetDate: '', entries: [] }, d.savings || {});
    return d;
  }

  function queueSave() {
    dirty = true;
    setStatus('Unsaved changes…', 'pending');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 1200);
  }

  async function save(force) {
    if (!data) return;
    if (saving) { clearTimeout(saveTimer); saveTimer = setTimeout(save, 800); return; }
    saving = true;
    setStatus('Saving…', 'pending');
    try {
      const r = await api('/data', { method: 'PUT', body: JSON.stringify({ data, baseUpdatedAt: updatedAt, force: !!force }) });
      if (r.ok) { updatedAt = r.body.updatedAt; dirty = false; setStatus('Saved ' + new Date(updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), 'ok'); }
      else if (r.status === 409) showConflict(r.body.current);
      else if (r.status === 401) renderGate('Your finance sign-in expired. Sign in again; unsaved edits on this screen were not saved.');
      else setStatus('Save failed: ' + (r.body.error || r.status), 'err');
    } catch (e) {
      setStatus('Save failed: no connection. Will retry.', 'err');
      clearTimeout(saveTimer); saveTimer = setTimeout(save, 8000);
    } finally { saving = false; }
  }

  function showConflict(current) {
    setStatus('Changed on another device', 'err');
    const box = $('finConflict'); if (!box) return;
    box.style.display = 'flex';
    box.innerHTML = '<span><i class="ti ti-alert-triangle"></i> These finances were changed on another device (' +
      esc(current && current.updatedAt ? new Date(current.updatedAt).toLocaleString() : 'unknown time') + ').</span>' +
      '<button class="btn btn-secondary" id="finUseTheirs">Load that version</button>' +
      '<button class="btn btn-danger" id="finKeepMine">Keep this screen (overwrite)</button>';
    $('finUseTheirs').onclick = () => { data = normalize(current.data); updatedAt = current.updatedAt; dirty = false; render(); setStatus('Loaded newer version', 'ok'); };
    $('finKeepMine').onclick = () => { box.style.display = 'none'; save(true); };
  }

  // ── calculations ──
  function amortize(balance, apr, payment) {
    if (balance == null || balance === '') return null;
    const B = num(balance), P = num(payment), r = num(apr) / 1200;
    if (B <= 0) return { months: 0, interest: 0, paid: true };
    if (P <= 0) return null;
    if (r > 0 && P <= B * r) return { never: true, monthlyInterest: B * r };
    let bal = B, months = 0, interest = 0;
    while (bal > 0.005 && months < 1200) {
      const i = bal * r; interest += i; bal = bal + i - P; months++;
    }
    return { months, interest };
  }

  function totals() {
    const inc = data.budget.income.reduce((s, x) => s + num(x.amount), 0);
    const exp = data.budget.expenses.reduce((s, x) => s + num(x.amount), 0);
    const debtPay = data.debts.filter(d => d.inBudget !== false).reduce((s, d) => s + num(d.payment), 0);
    const left = inc - exp - debtPay;
    const debtBal = data.debts.reduce((s, d) => s + num(d.balance), 0);
    const saved = data.savings.entries.reduce((s, e) => s + num(e.amount), 0);
    const year = String(new Date().getFullYear());
    const shiftsYTD = data.extraShifts.filter(s => (s.date || '').startsWith(year)).reduce((s, x) => s + num(x.amount), 0);
    return { inc, exp, debtPay, left, debtBal, saved, shiftsYTD };
  }

  function savingsPlan(t) {
    const goal = num(data.savings.goal);
    const remaining = Math.max(0, goal - t.saved);
    let monthsLeft = null, needed = null;
    if (data.savings.targetDate) {
      const now = new Date(), tgt = new Date(data.savings.targetDate + 'T00:00:00');
      monthsLeft = Math.max(0, (tgt.getFullYear() - now.getFullYear()) * 12 + (tgt.getMonth() - now.getMonth()));
      needed = monthsLeft > 0 ? remaining / monthsLeft : remaining;
    }
    const pct = goal > 0 ? Math.min(100, t.saved / goal * 100) : 0;
    return { goal, remaining, monthsLeft, needed, pct };
  }

  // ── rendering ──
  function cellNum(path, v, extra) {
    return '<input class="fin-cell fin-num fin-money" type="number" inputmode="decimal" step="0.01" data-path="' + path + '" data-type="num" value="' + (v == null ? '' : esc(v)) + '" placeholder="0.00"' + (extra || '') + '>';
  }
  function cellPct(path, v) {
    return '<input class="fin-cell fin-num" type="number" inputmode="decimal" step="0.01" data-path="' + path + '" data-type="num" value="' + (v == null ? '' : esc(v)) + '" placeholder="0.00">';
  }
  function cellText(path, v, ph) {
    return '<input class="fin-cell" type="text" data-path="' + path + '" data-type="text" value="' + esc(v) + '" placeholder="' + esc(ph || '') + '">';
  }
  function cellDate(path, v) {
    return '<input class="fin-cell" type="date" data-path="' + path + '" data-type="text" value="' + esc(v) + '">';
  }
  function cellSelect(path, v, opts) {
    return '<select class="fin-cell" data-path="' + path + '" data-type="text">' +
      opts.map(o => '<option' + (o === v ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
  }
  function delBtn(list, i) { return '<button class="fin-del" title="Delete row" data-del="' + list + '" data-i="' + i + '"><i class="ti ti-x"></i></button>'; }
  function addBtn(list, label) { return '<button class="btn btn-secondary fin-add" data-add="' + list + '"><i class="ti ti-plus"></i> ' + label + '</button>'; }

  function render() {
    const ws = $('financeWorkspace'); if (!ws || !data) return;
    const d = data;

    const incomeRows = d.budget.income.map((x, i) =>
      '<tr><td>' + cellText('budget.income.' + i + '.name', x.name, 'Income source') + '</td><td class="r">' + cellNum('budget.income.' + i + '.amount', x.amount) + '</td><td>' + delBtn('budget.income', i) + '</td></tr>').join('');

    const expenseRows = d.budget.expenses.map((x, i) =>
      '<tr><td>' + cellText('budget.expenses.' + i + '.name', x.name, 'Bill or expense') + '</td><td>' + cellSelect('budget.expenses.' + i + '.cat', x.cat || 'Other', CATS) + '</td><td class="r">' + cellNum('budget.expenses.' + i + '.amount', x.amount) + '</td><td>' + delBtn('budget.expenses', i) + '</td></tr>').join('');

    const debtRows = d.debts.map((x, i) =>
      '<tr><td>' + cellText('debts.' + i + '.name', x.name, 'Debt') + '</td><td>' + cellText('debts.' + i + '.lender', x.lender, 'Lender') + '</td>' +
      '<td class="r">' + cellNum('debts.' + i + '.balance', x.balance) + '</td><td class="r">' + cellPct('debts.' + i + '.rate', x.rate) + '</td><td class="r">' + cellNum('debts.' + i + '.payment', x.payment) + '</td>' +
      '<td class="c"><input type="checkbox" class="fin-check" data-path="debts.' + i + '.inBudget" data-type="bool"' + (x.inBudget !== false ? ' checked' : '') + ' title="Count this payment in the monthly budget"></td>' +
      '<td class="fin-calc" id="finDebtCalc' + i + '"></td><td>' + delBtn('debts', i) + '</td></tr>').join('');

    const shiftRows = d.extraShifts.map((x, i) =>
      '<tr><td>' + cellDate('extraShifts.' + i + '.date', x.date) + '</td><td class="r">' + cellNum('extraShifts.' + i + '.amount', x.amount) + '</td><td>' + cellSelect('extraShifts.' + i + '.dest', x.dest || 'Undecided', SHIFT_DEST) + '</td><td>' + cellText('extraShifts.' + i + '.note', x.note, 'Note') + '</td><td>' + delBtn('extraShifts', i) + '</td></tr>').join('');

    const saveRows = d.savings.entries.map((x, i) =>
      '<tr><td>' + cellDate('savings.entries.' + i + '.date', x.date) + '</td><td class="r">' + cellNum('savings.entries.' + i + '.amount', x.amount) + '</td><td>' + cellText('savings.entries.' + i + '.note', x.note, 'e.g. paycheck transfer, extra shift') + '</td><td>' + delBtn('savings.entries', i) + '</td></tr>').join('');

    ws.innerHTML =
      '<div class="fin-head">' +
        '<div><h1 class="ws-title">Finances</h1><div class="ws-sub" style="margin-bottom:0">private · stored on your Cloudflare server · not shared with Gemma\'s AI</div></div>' +
        '<div class="fin-tools">' +
          '<span class="fin-status" id="finStatus"></span>' +
          '<button class="btn btn-secondary" id="finBlurBtn" title="Hide numbers (for screen sharing)"><i class="ti ' + (blurred ? 'ti-eye' : 'ti-eye-off') + '"></i> ' + (blurred ? 'Show numbers' : 'Hide numbers') + '</button>' +
          '<button class="btn btn-secondary" id="finMenuBtn"><i class="ti ti-database-export"></i> Backup</button>' +
        '</div>' +
      '</div>' +
      '<div class="fin-menu" id="finMenu" style="display:none">' +
        '<button class="btn btn-secondary" id="finExport"><i class="ti ti-download"></i> Download a copy (JSON)</button>' +
        '<label class="btn btn-secondary"><i class="ti ti-upload"></i> Import a copy<input type="file" accept="application/json" id="finImport" style="display:none"></label>' +
        '<select class="text-input" id="finBackupSel" style="width:auto"><option value="">Restore a daily backup…</option></select>' +
      '</div>' +
      '<div class="fin-conflict" id="finConflict" style="display:none"></div>' +

      // summary
      '<div class="fin-kpis">' +
        kpi('Monthly income', 'finKInc') + kpi('Bills + debt payments', 'finKOut') + kpi('Left for savings', 'finKLeft') + kpi('Total debt', 'finKDebt') + kpi('Saved toward goal', 'finKSaved') +
      '</div>' +

      // budget
      '<div class="ws-section"><div class="ws-section-title">Monthly budget · base plan (2 scheduled CCH shifts)</div>' +
        '<div class="fin-grid2">' +
          '<div class="ws-card fin-card"><div class="fin-card-title">Income (take-home)</div>' +
            '<table class="fin-table"><thead><tr><th>Source</th><th class="r">Monthly</th><th></th></tr></thead><tbody>' + incomeRows + '</tbody>' +
            '<tfoot><tr><td>Total income</td><td class="r fin-money" id="finTInc"></td><td></td></tr></tfoot></table>' + addBtn('budget.income', 'Add income') +
          '</div>' +
          '<div class="ws-card fin-card"><div class="fin-card-title">Where it goes</div>' +
            '<div class="fin-flow" id="finFlow"></div>' +
            '<div class="fin-note">Debt payments come from the Debt tracker below (rows with "In budget" checked), so you never enter them twice. Extra CCH shifts are left out on purpose. They\'re bonus money, logged separately.</div>' +
          '</div>' +
        '</div>' +
        '<div class="ws-card fin-card" style="margin-top:14px"><div class="fin-card-title">Bills &amp; expenses</div>' +
          '<table class="fin-table"><thead><tr><th>Item</th><th>Category</th><th class="r">Monthly</th><th></th></tr></thead><tbody>' + expenseRows + '</tbody>' +
          '<tfoot><tr><td>Total bills &amp; expenses</td><td></td><td class="r fin-money" id="finTExp"></td><td></td></tr>' +
          '<tr><td>+ Debt payments (from tracker)</td><td></td><td class="r fin-money" id="finTDebtPay"></td><td></td></tr></tfoot></table>' + addBtn('budget.expenses', 'Add expense') +
        '</div>' +
      '</div>' +

      // debts
      '<div class="ws-section"><div class="ws-section-title">Debt tracker · highest rate first is the cheapest payoff order</div>' +
        '<div class="ws-card fin-card fin-scroll">' +
          '<table class="fin-table fin-debts"><thead><tr><th>Debt</th><th>Lender</th><th class="r">Balance</th><th class="r">APR %</th><th class="r">Payment</th><th class="c">In budget</th><th>Payoff at this payment</th><th></th></tr></thead><tbody>' + debtRows + '</tbody>' +
          '<tfoot><tr><td>Total</td><td></td><td class="r fin-money" id="finTDebt"></td><td></td><td class="r fin-money" id="finTDebtPay2"></td><td></td><td id="finDebtFree"></td><td></td></tr></tfoot></table>' + addBtn('debts', 'Add debt') +
          '<div class="fin-note">Payoff estimates assume a fixed rate and the same payment every month. Check balances against your lender statements; escrow, fees and rate changes will shift these dates.</div>' +
        '</div>' +
      '</div>' +

      // savings
      '<div class="ws-section"><div class="ws-section-title">Savings goal</div>' +
        '<div class="fin-grid2">' +
          '<div class="ws-card fin-card"><div class="fin-card-title">Goal</div>' +
            '<div class="fin-form"><label class="field-label">Goal amount</label>' + cellNum('savings.goal', d.savings.goal) +
            '<label class="field-label" style="margin-top:10px">Target date</label>' + cellDate('savings.targetDate', d.savings.targetDate) + '</div>' +
            '<div class="fin-progress"><div class="fin-progress-fill" id="finProg"></div></div>' +
            '<div class="fin-plan" id="finPlan"></div>' +
          '</div>' +
          '<div class="ws-card fin-card"><div class="fin-card-title">Deposits</div>' +
            '<table class="fin-table"><thead><tr><th>Date</th><th class="r">Amount</th><th>Note</th><th></th></tr></thead><tbody>' + saveRows + '</tbody>' +
            '<tfoot><tr><td>Total saved</td><td class="r fin-money" id="finTSaved"></td><td></td><td></td></tr></tfoot></table>' + addBtn('savings.entries', 'Add deposit') +
          '</div>' +
        '</div>' +
      '</div>' +

      // extra shifts
      '<div class="ws-section"><div class="ws-section-title">Extra CCH shifts · bonus money</div>' +
        '<div class="ws-card fin-card">' +
          '<table class="fin-table"><thead><tr><th>Date</th><th class="r">Take-home</th><th>Sent to</th><th>Note</th><th></th></tr></thead><tbody>' + shiftRows + '</tbody>' +
          '<tfoot><tr><td>This year</td><td class="r fin-money" id="finTShifts"></td><td colspan="3" id="finShiftSplit"></td></tr></tfoot></table>' + addBtn('extraShifts', 'Log extra shift') +
          '<div class="fin-note">If you put shift money into savings, also add it under Deposits so it counts toward the goal.</div>' +
        '</div>' +
      '</div>';

    applyBlur();
    wire();
    updateDerived();
    setStatus(dirty ? 'Unsaved changes…' : (updatedAt ? 'Saved ' + new Date(updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'New. Nothing saved yet'), dirty ? 'pending' : 'ok');
  }

  function kpi(label, id) {
    return '<div class="fin-kpi"><div class="fin-kpi-l">' + label + '</div><div class="fin-kpi-v fin-money" id="' + id + '"></div></div>';
  }

  function updateDerived() {
    if (!data) return;
    const t = totals();
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('finKInc', $$(t.inc)); set('finKOut', $$(t.exp + t.debtPay)); set('finKLeft', $$(t.left));
    set('finKDebt', $$(t.debtBal)); set('finKSaved', $$(t.saved));
    const kl = $('finKLeft'); if (kl) kl.dataset.neg = t.left < 0 ? '1' : '';
    set('finTInc', $$(t.inc)); set('finTExp', $$(t.exp)); set('finTDebtPay', $$(t.debtPay));
    set('finTDebt', $$(t.debtBal)); set('finTDebtPay2', $$(data.debts.reduce((s, x) => s + num(x.payment), 0)));
    set('finTSaved', $$(t.saved)); set('finTShifts', $$(t.shiftsYTD));

    // Where it goes (by category)
    const byCat = {};
    data.budget.expenses.forEach(x => { const c = x.cat || 'Other'; byCat[c] = (byCat[c] || 0) + num(x.amount); });
    if (t.debtPay) byCat['Debt payments'] = t.debtPay;
    const rows = Object.entries(byCat).filter(e => e[1] > 0).sort((a, b) => b[1] - a[1]);
    const flow = $('finFlow');
    if (flow) {
      const base = t.inc > 0 ? t.inc : rows.reduce((s, e) => s + e[1], 0) || 1;
      flow.innerHTML = (rows.length ? rows : [['Nothing entered yet', 0]]).map(e =>
        '<div class="fin-bar-row"><span class="fin-bar-l">' + esc(e[0]) + '</span><span class="fin-bar"><span style="width:' + Math.min(100, e[1] / base * 100).toFixed(1) + '%"></span></span><span class="fin-bar-v fin-money">' + $$(e[1]) + '</span><span class="fin-bar-p">' + (t.inc > 0 ? Math.round(e[1] / t.inc * 100) + '%' : '') + '</span></div>').join('') +
        '<div class="fin-bar-row fin-bar-left"><span class="fin-bar-l">Left for savings</span><span class="fin-bar"><span style="width:' + (t.inc > 0 ? Math.max(0, Math.min(100, t.left / t.inc * 100)).toFixed(1) : 0) + '%"></span></span><span class="fin-bar-v fin-money">' + $$(t.left) + '</span><span class="fin-bar-p">' + (t.inc > 0 ? Math.round(t.left / t.inc * 100) + '%' : '') + '</span></div>';
    }

    // Debt payoff per row
    let lastPayoff = null, unknown = false;
    data.debts.forEach((x, i) => {
      const el = $('finDebtCalc' + i); if (!el) return;
      const a = amortize(x.balance, x.rate, x.payment);
      if (!a) { el.innerHTML = '<span class="fin-dim">enter balance &amp; payment</span>'; unknown = true; return; }
      if (a.paid) { el.innerHTML = '<span class="fin-ok">paid off</span>'; return; }
      if (a.never) { el.innerHTML = '<span class="fin-bad">Payment doesn\'t cover interest (<span class="fin-money">' + $$(a.monthlyInterest) + '</span>/mo)</span>'; unknown = true; return; }
      const end = addMonths(new Date(), a.months);
      if (!lastPayoff || end > lastPayoff) lastPayoff = end;
      el.innerHTML = '<b>' + monthLabel(end) + '</b> <span class="fin-dim">· ' + a.months + ' mo · <span class="fin-money">' + $$(a.interest) + '</span> interest</span>';
    });
    const df = $('finDebtFree');
    if (df) df.innerHTML = lastPayoff ? ('All listed debts paid: <b>' + monthLabel(lastPayoff) + '</b>' + (unknown ? ' <span class="fin-dim">(some rows incomplete)</span>' : '')) : '';

    // Savings plan
    const p = savingsPlan(t);
    const prog = $('finProg'); if (prog) prog.style.width = p.pct.toFixed(1) + '%';
    const plan = $('finPlan');
    if (plan) {
      if (!p.goal) plan.innerHTML = '<span class="fin-dim">Set a goal amount to track progress.</span>';
      else {
        let h = '<div><b class="fin-money">' + $$(t.saved) + '</b> of <span class="fin-money">' + $$(p.goal) + '</span> (' + Math.round(p.pct) + '%)</div>';
        if (p.needed != null && p.remaining > 0) {
          h += '<div>Need <b class="fin-money">' + $$(p.needed) + '</b>/mo for ' + p.monthsLeft + ' more month' + (p.monthsLeft === 1 ? '' : 's') + ' to hit the target date.</div>';
          if (t.inc > 0) {
            const gap = t.left - p.needed;
            h += gap >= 0
              ? '<div class="fin-ok">The budget leaves <span class="fin-money">' + $$(t.left) + '</span>/mo, so you\'re on track with <span class="fin-money">' + $$(gap) + '</span> to spare.</div>'
              : '<div class="fin-bad">The budget leaves <span class="fin-money">' + $$(t.left) + '</span>/mo, which is <span class="fin-money">' + $$(-gap) + '</span>/mo short. Extra shifts or cuts would have to cover it.</div>';
          }
        } else if (p.remaining <= 0) h += '<div class="fin-ok">Goal reached.</div>';
        else h += '<div class="fin-dim">Add a target date to see the monthly amount needed.</div>';
        plan.innerHTML = h;
      }
    }

    // Shift split
    const split = $('finShiftSplit');
    if (split) {
      const year = String(new Date().getFullYear()), by = {};
      data.extraShifts.filter(s => (s.date || '').startsWith(year)).forEach(s => { const k = s.dest || 'Undecided'; by[k] = (by[k] || 0) + num(s.amount); });
      split.innerHTML = Object.keys(by).length ? Object.entries(by).map(e => esc(e[0]) + ' <span class="fin-money">' + $$(e[1]) + '</span>').join(' · ') : '';
    }
    applyBlur();
  }

  function applyBlur() {
    const p = $('panel-finance'); if (p) p.classList.toggle('fin-blurred', blurred);
  }

  function getList(path) { return path.split('.').reduce((o, k) => o[k], data); }
  function setPath(path, value) {
    const keys = path.split('.'); let o = data;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = value;
  }

  function wire() {
    const ws = $('financeWorkspace');
    ws.oninput = ws.onchange = (e) => {
      const el = e.target; if (!el.dataset || !el.dataset.path) return;
      const type = el.dataset.type;
      const v = type === 'num' ? (el.value === '' ? null : parseFloat(el.value)) : type === 'bool' ? el.checked : el.value;
      setPath(el.dataset.path, v);
      updateDerived();
      queueSave();
    };
    ws.onclick = (e) => {
      const add = e.target.closest('[data-add]');
      if (add) {
        const list = getList(add.dataset.add), today = new Date().toISOString().slice(0, 10);
        const blank = {
          'budget.income': { name: '', amount: null },
          'budget.expenses': { name: '', cat: 'Other', amount: null },
          'debts': { name: '', lender: '', balance: null, rate: null, payment: null, inBudget: true },
          'extraShifts': { date: today, amount: null, dest: 'Savings', note: '' },
          'savings.entries': { date: today, amount: null, note: '' }
        }[add.dataset.add];
        list.push(blank); render(); queueSave();
        const rows = ws.querySelectorAll('[data-path^="' + add.dataset.add + '.' + (list.length - 1) + '."]');
        if (rows[0]) rows[0].focus();
        return;
      }
      const del = e.target.closest('[data-del]');
      if (del) {
        const list = getList(del.dataset.del), i = +del.dataset.i, row = list[i];
        const label = (row && (row.name || row.date)) || 'this row';
        if (!confirm('Delete ' + label + '?')) return;
        list.splice(i, 1); render(); queueSave();
      }
    };
    $('finBlurBtn').onclick = () => {
      blurred = !blurred;
      try { localStorage.setItem(FIN_BLUR_KEY, blurred ? '1' : '0'); } catch (e) {}
      render();
    };
    $('finMenuBtn').onclick = async () => {
      const m = $('finMenu'); const show = m.style.display === 'none';
      m.style.display = show ? 'flex' : 'none';
      if (show) {
        const sel = $('finBackupSel');
        sel.length = 1;
        const r = await api('/backups').catch(() => null);
        if (r && r.ok) r.body.forEach(day => { const o = document.createElement('option'); o.value = day; o.textContent = 'Start of ' + day; sel.appendChild(o); });
      }
    };
    $('finExport').onclick = () => {
      const blob = new Blob([JSON.stringify({ data, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'gemma-finances-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    $('finImport').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const obj = JSON.parse(await f.text());
        if (!confirm('Replace everything on this page with the imported copy?')) return;
        data = normalize(obj.data || obj); render(); queueSave();
      } catch (err) { alert('That file is not a valid finance export.'); }
    };
    $('finBackupSel').onchange = async (e) => {
      const day = e.target.value; if (!day) return;
      if (!confirm('Replace the current finances with the backup from the start of ' + day + '? (Today\'s version is kept as a backup first.)')) { e.target.value = ''; return; }
      const r = await api('/backups/' + day);
      if (r.ok && r.body && r.body.data) { data = normalize(r.body.data); render(); queueSave(); }
      else alert('Could not load that backup.');
    };
  }

  function renderGate(msg) {
    const ws = $('financeWorkspace'); if (!ws) return;
    ws.innerHTML =
      '<h1 class="ws-title">Finances</h1><div class="ws-sub">private · Google sign-in required</div>' +
      '<div class="ws-card fin-gate"><i class="ti ti-lock" style="font-size:28px;color:var(--brass)"></i>' +
      '<p>Sign in with <b>ashley@cognitivenursing.io</b> to unlock your finances. The numbers are stored on your own Cloudflare server and checked there, not in this page.</p>' +
      '<div id="finGsi" style="min-height:44px"></div>' +
      (msg ? '<div class="lock-err" style="display:block">' + esc(msg) + '</div>' : '') + '</div>';
    (function tryRender() {
      if (!window.google || !google.accounts || !google.accounts.id) { setTimeout(tryRender, 250); return; }
      if (typeof window.initGoogleButton === 'function') window.initGoogleButton();
      const el = $('finGsi'); if (!el) return;
      google.accounts.id.renderButton(el, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 280 });
    })();
  }

  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  window.financeAuth = financeAuth;
  window.financeSignOut = financeSignOut;
  window.financeOpen = financeOpen;
})();
