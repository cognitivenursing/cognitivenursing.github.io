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

  // Quick Add / transactions
  const TX_TYPES = {
    'Paycheck':     { dir: 'in',   icon: 'ti-cash' },
    'Extra shift':  { dir: 'in',   icon: 'ti-stethoscope' },
    'Other income': { dir: 'in',   icon: 'ti-plus' },
    'Purchase':     { dir: 'out',  icon: 'ti-shopping-cart', cat: true },
    'Bill':         { dir: 'out',  icon: 'ti-file-invoice', cat: true },
    'Debt payment': { dir: 'out',  icon: 'ti-credit-card', debt: true },
    'To savings':   { dir: 'save', icon: 'ti-pig-money' }
  };
  function localDate(d) { d = d || new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
  let viewMonth = localDate().slice(0, 7);
  let qaType = 'Purchase', qaDate = '', qaCat = 'Food', qaDebt = '', qaAcct = '', qaTo = '', focusQA = false;
  const ACCT_TYPES = ['Checking', 'Savings', 'Money market', 'Share term certificate', 'IRA', 'Holiday / vacation savings', 'Other'];

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
    if (location.hash === '#quickadd') focusQA = true;
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
      else { data = normalize(template()); updatedAt = null; }
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
    d.transactions = d.transactions || [];
    if (!Array.isArray(d.accounts)) {
      d.accounts = [
        { inst: 'SECU', name: "Ashley's Allowance", type: 'Checking' },
        { inst: 'SECU', name: "Kim's Checking", type: 'Checking' },
        { inst: 'SECU', name: 'Doctorate Account', type: 'Savings' },
        { inst: 'SECU', name: 'Household Checking', type: 'Checking' },
        { inst: 'SECU', name: 'Money Market', type: 'Money market' },
        { inst: 'SECU', name: 'Share', type: 'Savings' }
      ].map(a => Object.assign({ last4: '', balance: null, asOf: '', notes: '' }, a));
    }
    d.accounts.forEach(x => { if (!x.id) x.id = uid(); });
    d.debts.forEach(x => { if (!x.id) x.id = uid(); });
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
    const saved = data.savings.entries.reduce((s, e) => s + num(e.amount), 0) +
      data.transactions.filter(t => t.type === 'To savings').reduce((s, t) => s + num(t.amount), 0);
    const year = String(new Date().getFullYear());
    const shiftsYTD = data.extraShifts.filter(s => (s.date || '').startsWith(year)).reduce((s, x) => s + num(x.amount), 0) +
      data.transactions.filter(t => t.type === 'Extra shift' && (t.date || '').startsWith(year)).reduce((s, t) => s + num(t.amount), 0);
    return { inc, exp, debtPay, left, debtBal, saved, shiftsYTD };
  }

  function monthStats(month) {
    const st = { inc: 0, out: 0, save: 0, byCat: {}, byDebt: {} };
    data.transactions.forEach(t => {
      if (!(t.date || '').startsWith(month)) return;
      const T = TX_TYPES[t.type] || TX_TYPES['Purchase'], a = num(t.amount);
      if (T.dir === 'in') st.inc += a;
      else if (T.dir === 'save') st.save += a;
      else {
        st.out += a;
        const c = T.debt ? 'Debt payments' : (t.cat || 'Other');
        st.byCat[c] = (st.byCat[c] || 0) + a;
        if (T.debt && t.debtId) st.byDebt[t.debtId] = (st.byDebt[t.debtId] || 0) + a;
      }
    });
    return st;
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
        kpi('Monthly income', 'finKInc') + kpi('Bills + debt payments', 'finKOut') + kpi('Left for savings', 'finKLeft') + kpi('Total debt', 'finKDebt') + kpi('Cash in accounts', 'finKCash') + kpi('Saved toward goal', 'finKSaved') +
      '</div>' +

      quickAddHTML() + monthHTML() + accountsHTML() +

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
          '<div class="fin-note">Shifts logged with Quick Add count in "This year" automatically; this table is for anything you want to track separately. If shift money goes to savings, log it as "To savings" in Quick Add so it counts toward the goal.</div>' +
        '</div>' +
      '</div>';

    applyBlur();
    wire();
    setQAFields();
    if (focusQA) { focusQA = false; const a = $('qaAmount'); if (a) { $('finQA').scrollIntoView({ block: 'start' }); a.focus(); } }
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
    const est = acctEstimates(); let cash = 0, anyBal = false;
    data.accounts.forEach((a, i) => {
      const e = est[a.id], el = $('finAcctEst' + i);
      if (e == null) { if (el) el.innerHTML = '<span class="fin-dim">enter balance</span>'; return; }
      anyBal = true; cash += e.value;
      if (el) el.innerHTML = '<b class="fin-money' + (e.value < 0 ? ' fin-bad' : '') + '">' + $$(e.value) + '</b>' +
        (e.change ? ' <span class="fin-dim">(' + (e.change > 0 ? '+' : '−') + '<span class="fin-money">' + $$(Math.abs(e.change)) + '</span> logged since)</span>' : '');
    });
    set('finKCash', anyBal ? $$(cash) : '—'); set('finTAcct', $$(cash));
    set('finTAcctBal', $$(data.accounts.reduce((s, a) => s + num(a.balance), 0)));
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
      const paidMo = monthStats(localDate().slice(0, 7)).byDebt[x.id] || 0;
      el.innerHTML = '<b>' + monthLabel(end) + '</b> <span class="fin-dim">· ' + a.months + ' mo · <span class="fin-money">' + $$(a.interest) + '</span> interest</span>' +
        (paidMo ? ' <span class="fin-ok">· paid this month <span class="fin-money">' + $$(paidMo) + '</span></span>' : '');
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
      if (e.type === 'change' && /^accounts\.\d+\.(name|inst|last4)$/.test(el.dataset.path)) { render(); queueSave(); return; }
      if (e.type === 'change' && /^transactions\.\d+\.(type|date|amount|cat|debtId|accountId|toAccountId)$/.test(el.dataset.path)) { render(); queueSave(); return; }
      updateDerived();
      queueSave();
    };
    ws.onclick = (e) => {
      const qt = e.target.closest('[data-qatype]');
      if (qt) { qaType = qt.dataset.qatype; ws.querySelectorAll('[data-qatype]').forEach(b => b.classList.toggle('on', b === qt)); setQAFields(); $('qaAmount').focus(); return; }
      if (e.target.closest('#qaSave')) { qaSave(); return; }
      const add = e.target.closest('[data-add]');
      if (add) {
        const list = getList(add.dataset.add), today = localDate();
        const blank = {
          'budget.income': { name: '', amount: null },
          'budget.expenses': { name: '', cat: 'Other', amount: null },
          'debts': { name: '', lender: '', balance: null, rate: null, payment: null, inBudget: true },
          'accounts': { inst: 'SECU', name: '', type: 'Savings', last4: '', balance: null, asOf: today, notes: '' },
          'extraShifts': { date: today, amount: null, dest: 'Savings', note: '' },
          'savings.entries': { date: today, amount: null, note: '' }
        }[add.dataset.add];
        if (add.dataset.add === 'debts' || add.dataset.add === 'accounts') blank.id = uid();
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
    $('finMonth').onchange = (e) => { if (e.target.value) { viewMonth = e.target.value; render(); } };
    ['qaAmount', 'qaNote'].forEach(id => { $(id).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); qaSave(); } }; });
    $('qaDate').onchange = (e) => { qaDate = e.target.value; };
    $('qaCat').onchange = (e) => { qaCat = e.target.value; };
    $('qaDebt').onchange = (e) => { qaDebt = e.target.value; };
    $('qaAcct').onchange = (e) => { qaAcct = e.target.value; };
    $('qaTo').onchange = (e) => { qaTo = e.target.value; };
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
      a.download = 'gemma-finances-' + localDate() + '.json'; a.click();
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

  function selectVL(path, value, pairs, cls) {
    return '<select class="' + (cls || 'fin-cell') + '"' + (path ? ' data-path="' + path + '" data-type="text"' : '') + '>' +
      pairs.map(p => '<option value="' + esc(p[0]) + '"' + (p[0] === value ? ' selected' : '') + '>' + esc(p[1]) + '</option>').join('') + '</select>';
  }
  function acctLabel(a) { return [a.inst, a.name || a.type].filter(Boolean).join(' ') + (a.last4 ? ' ··' + a.last4 : ''); }
  function acctPairs() { return data.accounts.map(a => [a.id, acctLabel(a)]); }

  // Estimated balance now = statement balance + Quick Add entries tagged to the account after the "as of" date
  function acctEstimates() {
    const out = {};
    data.accounts.forEach(a => {
      if (a.balance == null || a.balance === '') return;
      let change = 0;
      data.transactions.forEach(t => {
        if (a.asOf && !((t.date || '') > a.asOf)) return;
        const T = TX_TYPES[t.type] || {}, amt = num(t.amount);
        if (t.accountId === a.id) change += T.dir === 'in' ? amt : -amt;
        if (T.dir === 'save' && t.toAccountId === a.id) change += amt;
      });
      out[a.id] = { value: num(a.balance) + change, change };
    });
    return out;
  }

  function accountsHTML() {
    const rows = data.accounts.map((a, i) =>
      '<tr><td>' + cellText('accounts.' + i + '.inst', a.inst, 'Bank') + '</td>' +
      '<td>' + cellText('accounts.' + i + '.name', a.name, 'Nickname (e.g. Emergency fund)') + '</td>' +
      '<td>' + cellSelect('accounts.' + i + '.type', a.type || 'Other', ACCT_TYPES) + '</td>' +
      '<td><input class="fin-cell fin-last4" type="text" inputmode="numeric" maxlength="4" pattern="[0-9]*" data-path="accounts.' + i + '.last4" data-type="text" value="' + esc(a.last4) + '" placeholder="1234"></td>' +
      '<td class="r">' + cellNum('accounts.' + i + '.balance', a.balance) + '</td>' +
      '<td>' + cellDate('accounts.' + i + '.asOf', a.asOf) + '</td>' +
      '<td class="fin-calc" id="finAcctEst' + i + '"></td>' +
      '<td>' + cellText('accounts.' + i + '.notes', a.notes, 'Purpose, auto-transfers…') + '</td>' +
      '<td>' + delBtn('accounts', i) + '</td></tr>').join('');
    return '<div class="ws-section"><div class="ws-section-title">Accounts</div>' +
      '<div class="ws-card fin-card fin-scroll">' +
        '<table class="fin-table fin-accts"><thead><tr><th>Bank</th><th>Account</th><th>Type</th><th>Last 4</th><th class="r">Balance</th><th>As of</th><th>Estimated now</th><th>Notes</th><th></th></tr></thead><tbody>' + rows + '</tbody>' +
        '<tfoot><tr><td>Total</td><td></td><td></td><td></td><td class="r fin-money" id="finTAcctBal"></td><td></td><td class="fin-money" id="finTAcct"></td><td></td><td></td></tr></tfoot></table>' +
        addBtn('accounts', 'Add account') +
        '<div class="fin-note">Enter each balance from SECU online banking or your statement, with the date. "Estimated now" adds the Quick Add entries tagged to that account after that date, so pick the account when you log a paycheck, purchase or transfer. Re-enter the real balance every week or two to catch anything not logged. Last 4 digits only, never the full account number.</div>' +
      '</div></div>';
  }

  function debtPairs() { return data.debts.map(x => [x.id, x.name || '(unnamed debt)']); }

  function quickAddHTML() {
    if (!qaDebt && data.debts[0]) qaDebt = data.debts[0].id;
    return '<div class="ws-section" id="finQA"><div class="ws-section-title">Quick add · log money as it moves</div>' +
      '<div class="ws-card fin-card">' +
        '<div class="fin-qa-types">' + Object.keys(TX_TYPES).map(k =>
          '<button class="fin-qa-type' + (k === qaType ? ' on' : '') + '" data-qatype="' + esc(k) + '"><i class="ti ' + TX_TYPES[k].icon + '"></i> ' + esc(k) + '</button>').join('') + '</div>' +
        '<div class="fin-qa-row">' +
          '<input id="qaAmount" class="text-input fin-qa-amt" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00" aria-label="Amount">' +
          '<input id="qaDate" class="text-input fin-qa-date" type="date" value="' + esc(qaDate || localDate()) + '" aria-label="Date">' +
          selectVL('', qaCat, CATS.map(c => [c, c]), 'text-input fin-qa-sel" id="qaCat') +
          selectVL('', qaDebt, debtPairs(), 'text-input fin-qa-sel" id="qaDebt') +
          '<label class="fin-qa-lab" id="qaAcctWrap"><span id="qaAcctLab">From</span>' + selectVL('', qaAcct, [['', 'no account']].concat(acctPairs()), 'text-input fin-qa-sel" id="qaAcct') + '</label>' +
          '<label class="fin-qa-lab" id="qaToWrap"><span>To</span>' + selectVL('', qaTo, [['', 'no account']].concat(acctPairs()), 'text-input fin-qa-sel" id="qaTo') + '</label>' +
          '<input id="qaNote" class="text-input fin-qa-note" type="text" placeholder="Note (store, what, who)" aria-label="Note">' +
          '<button class="btn btn-primary" id="qaSave"><i class="ti ti-plus"></i> Add</button>' +
        '</div>' +
        '<div class="fin-qa-msg" id="qaMsg"></div>' +
      '</div></div>';
  }

  function setQAFields() {
    const T = TX_TYPES[qaType] || {};
    const c = $('qaCat'), d = $('qaDebt'); if (!c || !d) return;
    c.style.display = T.cat ? '' : 'none';
    d.style.display = T.debt ? '' : 'none';
    const hasA = data.accounts.length > 0;
    $('qaAcctWrap').style.display = hasA ? '' : 'none';
    $('qaToWrap').style.display = hasA && T.dir === 'save' ? '' : 'none';
    $('qaAcctLab').textContent = T.dir === 'in' ? 'Into' : 'From';
    if (qaType === 'Bill' && qaCat === 'Food') { qaCat = 'Utilities'; c.value = qaCat; }
  }

  function qaSave() {
    const amt = parseFloat($('qaAmount').value);
    const msg = $('qaMsg');
    if (!isFinite(amt) || amt <= 0) { msg.textContent = 'Enter an amount first.'; msg.dataset.kind = 'err'; $('qaAmount').focus(); return; }
    const T = TX_TYPES[qaType];
    if (T.debt && !data.debts.length) { msg.textContent = 'Add the debt in the Debt tracker first.'; msg.dataset.kind = 'err'; return; }
    const tx = { id: uid(), date: $('qaDate').value || localDate(), type: qaType, amount: Math.round(amt * 100) / 100, note: $('qaNote').value.trim() };
    if (T.cat) tx.cat = $('qaCat').value;
    if (T.debt) tx.debtId = $('qaDebt').value;
    if ($('qaAcct').value) tx.accountId = $('qaAcct').value;
    if (T.dir === 'save' && $('qaTo').value) tx.toAccountId = $('qaTo').value;
    data.transactions.push(tx);
    qaDate = tx.date;
    viewMonth = tx.date.slice(0, 7);
    render(); queueSave();
    const label = T.debt ? (data.debts.find(x => x.id === tx.debtId) || {}).name : (tx.cat || qaType);
    const m = $('qaMsg'); m.textContent = 'Added ' + $$(tx.amount) + ' · ' + qaType + (T.cat || T.debt ? ' · ' + label : '') + '. Undo by deleting it below.'; m.dataset.kind = 'ok';
    $('qaAmount').focus();
  }

  function monthHTML() {
    const st = monthStats(viewMonth), t = totals();
    const [y, m] = viewMonth.split('-').map(Number);
    const mLabel = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const planned = {};
    data.budget.expenses.forEach(x => { const c = x.cat || 'Other'; planned[c] = (planned[c] || 0) + num(x.amount); });
    if (t.debtPay) planned['Debt payments'] = t.debtPay;
    const cats = [...new Set([...CATS, 'Debt payments'])].filter(c => (planned[c] || 0) > 0 || (st.byCat[c] || 0) > 0);
    const catRows = cats.map(c => {
      const p = planned[c] || 0, sp = st.byCat[c] || 0, left = p - sp, pct = p > 0 ? Math.min(100, sp / p * 100) : 100;
      return '<tr><td>' + esc(c) + '</td><td class="r fin-money">' + $$(p) + '</td><td class="r fin-money">' + $$(sp) + '</td>' +
        '<td class="r"><span class="fin-money ' + (left < 0 ? 'fin-bad' : '') + '">' + (left < 0 ? '−' + $$(-left) + ' over' : $$(left)) + '</span></td>' +
        '<td style="width:22%"><span class="fin-bar' + (left < 0 ? ' fin-bar-over' : '') + '"><span style="width:' + pct.toFixed(1) + '%"></span></span></td></tr>';
    }).join('');

    const idx = data.transactions.map((x, i) => i).filter(i => (data.transactions[i].date || '').startsWith(viewMonth))
      .sort((a, b) => (data.transactions[b].date || '').localeCompare(data.transactions[a].date || '') || b - a);
    const typePairs = Object.keys(TX_TYPES).map(k => [k, k]);
    const txRows = idx.map(i => {
      const x = data.transactions[i], T = TX_TYPES[x.type] || {};
      const detail = T.cat ? selectVL('transactions.' + i + '.cat', x.cat || 'Other', CATS.map(c => [c, c]))
        : T.debt ? selectVL('transactions.' + i + '.debtId', x.debtId, debtPairs())
        : (T.dir === 'save' && data.accounts.length) ? selectVL('transactions.' + i + '.toAccountId', x.toAccountId || '', [['', 'to: no account']].concat(acctPairs()))
        : '<span class="fin-dim" style="padding-left:8px">—</span>';
      const acctCell = data.accounts.length ? selectVL('transactions.' + i + '.accountId', x.accountId || '', [['', '—']].concat(acctPairs())) : '<span class="fin-dim">—</span>';
      return '<tr class="fin-tx-' + (T.dir || 'out') + '"><td>' + cellDate('transactions.' + i + '.date', x.date) + '</td><td>' + selectVL('transactions.' + i + '.type', x.type, typePairs) + '</td>' +
        '<td>' + detail + '</td><td>' + acctCell + '</td><td class="r">' + cellNum('transactions.' + i + '.amount', x.amount) + '</td><td>' + cellText('transactions.' + i + '.note', x.note, '') + '</td><td>' + delBtn('transactions', i) + '</td></tr>';
    }).join('');

    const net = st.inc - st.out - st.save;
    return '<div class="ws-section"><div class="fin-month-head"><div class="ws-section-title" style="margin:0">Following the money · ' + esc(mLabel) + '</div>' +
        '<input type="month" class="text-input" id="finMonth" value="' + esc(viewMonth) + '" style="width:auto">' + '</div>' +
      '<div class="fin-kpis fin-kpis-sm">' +
        '<div class="fin-kpi"><div class="fin-kpi-l">Money in</div><div class="fin-kpi-v fin-money fin-ok">' + $$(st.inc) + '</div><div class="fin-kpi-s">plan ' + '<span class="fin-money">' + $$(t.inc) + '</span></div></div>' +
        '<div class="fin-kpi"><div class="fin-kpi-l">Money out</div><div class="fin-kpi-v fin-money">' + $$(st.out) + '</div><div class="fin-kpi-s">plan <span class="fin-money">' + $$(t.exp + t.debtPay) + '</span></div></div>' +
        '<div class="fin-kpi"><div class="fin-kpi-l">To savings</div><div class="fin-kpi-v fin-money">' + $$(st.save) + '</div><div class="fin-kpi-s">plan <span class="fin-money">' + $$(Math.max(0, t.left)) + '</span></div></div>' +
        '<div class="fin-kpi"><div class="fin-kpi-l">Not yet assigned</div><div class="fin-kpi-v fin-money" data-neg="' + (net < 0 ? '1' : '') + '">' + $$(net) + '</div><div class="fin-kpi-s">in − out − savings</div></div>' +
      '</div>' +
      '<div>' +
        '<div class="ws-card fin-card"><div class="fin-card-title">Spending vs plan</div>' +
          (catRows ? '<table class="fin-table"><thead><tr><th>Category</th><th class="r">Plan</th><th class="r">Spent</th><th class="r">Left</th><th></th></tr></thead><tbody>' + catRows + '</tbody></table>'
                   : '<div class="fin-dim" style="font-size:13px">Fill in the budget below and log purchases to see this.</div>') +
        '</div>' +
        '<div class="ws-card fin-card fin-scroll" style="margin-top:14px"><div class="fin-card-title">Entries (' + idx.length + ')</div>' +
          (txRows ? '<table class="fin-table fin-tx"><thead><tr><th>Date</th><th>Type</th><th>Category / debt / to</th><th>Account</th><th class="r">Amount</th><th>Note</th><th></th></tr></thead><tbody>' + txRows + '</tbody></table>'
                  : '<div class="fin-dim" style="font-size:13px">Nothing logged for this month yet.</div>') +
        '</div>' +
      '</div>' +
      '<div class="fin-note">Debt payments show as "paid this month" in the Debt tracker; update each balance from your lender statement, since the interest/principal split comes from the lender. "To savings" entries count toward the Savings goal automatically, as do "Extra shift" entries toward the shift total, so don\'t also add them to those tables.</div>' +
    '</div>';
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
