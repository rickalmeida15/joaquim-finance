// ---------- Utilidades ----------
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = c => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDate = s => s.split('-').reverse().join('/');
const monthKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const shiftKey = (k, n) => { const [y, m] = k.split('-').map(Number); return monthKey(new Date(y, m - 1 + n, 1)); };
const monthLabel = k => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' }).replace('.', '').replace(/^./, c => c.toUpperCase()); };
const addMonths = (d, n) => {
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last));
};
const invoiceKeyOf = (d, card) => d.getDate() >= card.closingDay ? shiftKey(monthKey(d), 1) : monthKey(d);
const openInvoiceKey = card => invoiceKeyOf(new Date(), card);
const uid = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function loadJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch (e) { return fallback; }
}

function parseMoney(s) {
  if (typeof s === 'number') return Math.round(s * 100);
  s = s.replace(/[.,]+$/, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n * 100);
}

// ---------- Dados & Categorias ----------
let cards = loadJSON('finances_cards', [
  { id: 'nubank', name: 'Nubank', closingDay: 5, dueDay: 12, balance: 0 },
  { id: 'itau', name: 'Itaú', closingDay: 15, dueDay: 22, balance: 0 }
]);
cards.forEach(c => { if (typeof c.balance !== 'number') c.balance = 0; });

let customCategories = loadJSON('finances_categories', ['Alimentação', 'Transporte', 'Mercado', 'Geral']);

let categoryMetas = loadJSON('finances_metas', {
  'Alimentação': 80000,
  'Mercado': 120000,
  'Transporte': 40000
});

let recurring = loadJSON('finances_recurring', []);
let paidInvoices = loadJSON('finances_paid', []);
const normTxt = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function saveCategories() {
  try { localStorage.setItem('finances_categories', JSON.stringify(customCategories)); } catch (e) {}
}

function populateCategoryDropdowns() {
  const metaSelect = $('metaCategorySelect');
  if (metaSelect) {
    metaSelect.innerHTML = customCategories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('') +
                           `<option value="__NEW__">+ Outra Categoria...</option>`;
  }

  const editSelect = $('editCategorySelect');
  if (editSelect) {
    editSelect.innerHTML = [...customCategories, ...(customCategories.includes('Receita') ? [] : ['Receita'])].map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  }
}

function toggleNewCategoryInput() {
  const select = $('metaCategorySelect');
  const isNew = select.value === '__NEW__';
  $('newCategoryContainer').classList.toggle('hidden', !isNew);
  if (isNew) $('newCategoryInput').focus();
}

function migrate(t) {
  if (typeof t.cents === 'number') return t;
  const parts = (t.date || '').split('/');
  return {
    id: t.id, groupId: t.groupId || t.id,
    total: t.totalInstallments || 1, idx: t.installmentIndex || 1,
    name: t.cleanName || (t.description || '').replace(/\s*\(\d+\/\d+\)/, ''),
    cents: Math.round((t.amount || 0) * 100),
    category: t.category, method: t.paymentMethod, cardId: t.cardId || null,
    date: parts.length === 3 ? `${parts[2]}-${parts[1]}-${parts[0]}` : isoDate(new Date())
  };
}

let transactions = loadJSON('finances_v2', null);
if (!transactions) transactions = loadJSON('finances_db', []).map(migrate);

let pendingTransaction = null, deletingTransaction = null, editingTransactionId = null, expandedCardId = null;
let extratoOffset = 0, faturaOffset = 0, relatorioOffset = 0;
let myChart = null;

const save = () => {
  try {
    localStorage.setItem('finances_v2', JSON.stringify(transactions));
    localStorage.setItem('finances_cards', JSON.stringify(cards));
    localStorage.setItem('finances_metas', JSON.stringify(categoryMetas));
    localStorage.setItem('finances_recurring', JSON.stringify(recurring));
    localStorage.setItem('finances_paid', JSON.stringify(paidInvoices));
    localStorage.setItem('finances_goals', JSON.stringify(goals));
    saveCategories();
  } catch (e) { toast('Não foi possível salvar os dados neste navegador.'); }
};

const refresh = () => { save(); renderAll(); };
const renderAll = () => { renderExtrato(); renderCartoes(); renderSaldos(); renderRelatorios(); populateCategoryDropdowns(); renderRecurring(); renderForecast(); renderAlerts(); renderHome(); renderGoals(); renderSecurity(); fitChat(); };

document.addEventListener('DOMContentLoaded', () => {
  startClock(); startLock(); generateRecurring(); switchTab('chat'); save(); renderAll();
});

function startClock() {
  const tick = () => {
    const n = new Date();
    $('clockText').innerText = `${n.toLocaleDateString('pt-BR')} • ${n.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  };
  tick(); setInterval(tick, 1000);
}

// ---------- Cartões ----------
let editingCardId = null;
function openCardModal(id) {
  const c = typeof id === 'string' ? cards.find(x => x.id === id) : null;
  editingCardId = c ? c.id : null;
  $('cardModalTitle').innerText = c ? 'Editar Cartão' : 'Adicionar Cartão';
  $('cardDeleteBtn').classList.toggle('hidden', !c);
  if (c) {
    $('newCardName').value = c.name; $('newCardClosing').value = c.closingDay; $('newCardDue').value = c.dueDay;
    $('newCardBalance').value = (accountBalance(c) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  }
  $('cardModal').classList.remove('hidden');
}
function deleteCard() {
  const c = cards.find(x => x.id === editingCardId); if (!c) return;
  if (!confirm(`Excluir "${c.name}"? Os lançamentos continuam no Extrato, mas ficam sem cartão.`)) return;
  transactions.forEach(t => { if (t.cardId === c.id) t.cardId = null; });
  recurring.forEach(r => { if (r.cardId === c.id) r.cardId = null; });
  cards = cards.filter(x => x.id !== c.id);
  refresh(); closeCardModal();
}
function closeCardModal() {
  $('cardModal').classList.add('hidden');
  editingCardId = null; $('cardModalTitle').innerText = 'Adicionar Cartão'; $('cardDeleteBtn').classList.add('hidden');
  ['newCardName', 'newCardClosing', 'newCardDue', 'newCardBalance'].forEach(i => $(i).value = '');
}

function saveNewCard() {
  const name = $('newCardName').value.trim();
  const closingDay = parseInt($('newCardClosing').value);
  const dueDay = parseInt($('newCardDue').value);
  const okDay = d => d >= 1 && d <= 31;
  if (!name || !okDay(closingDay) || !okDay(dueDay)) { toast('Preencha nome e dias (1 a 31) do cartão.'); return; }
  const balTxt = $('newCardBalance').value.trim();
  if (editingCardId) {
    const c = cards.find(x => x.id === editingCardId);
    if (c) {
      c.name = name; c.closingDay = closingDay; c.dueDay = dueDay;
      if (balTxt !== '') { const neg = balTxt.startsWith('-'); const v = parseMoney(balTxt.replace('-', '')); c.balance = (neg ? -v : v) + debitSum(c) - incomeSum(c) + goalMovSum(c); }
    }
  } else cards.push({ id: uid(), name, closingDay, dueDay, balance: parseMoney(balTxt) });
  refresh(); closeCardModal();
}

const debitSum = card => transactions.filter(t => t.cardId === card.id && (t.method === 'Débito' || t.method === 'PIX')).reduce((a, t) => a + t.cents, 0);
const incomeSum = card => transactions.filter(t => t.cardId === card.id && t.method === 'Entrada').reduce((a, t) => a + t.cents, 0);
const accountBalance = card => card.balance - debitSum(card) + incomeSum(card) - goalMovSum(card);
const isExpense = t => t.method !== 'Entrada' && t.category !== 'Pagamento de Fatura'; // entrada (receita) não conta como gasto

function setBalance(cardId) {
  const card = cards.find(c => c.id === cardId); if (!card) return;
  const v = prompt(`Quanto você tem hoje na conta ${card.name}? (ex: 1.500,00)`);
  if (v === null) return;
  const neg = v.trim().startsWith('-');
  const cents = parseMoney(v.replace('-', '').trim());
  card.balance = (neg ? -cents : cents) + debitSum(card) - incomeSum(card) + goalMovSum(card);
  refresh();
}

// ---------- Navegação Fluida ----------
function switchTab(tab, dir = 0, plain = false) {
  if (cardsTransitioning) return;
  if (!plain) {
    const onCards = !$('tabCartoes').classList.contains('hidden'), onExt = !$('tabExtrato').classList.contains('hidden');
    if (tab === 'cartoes' && onExt) { animateCards(true); return; }
    if (tab === 'extrato' && onCards) { animateCards(false); return; }
  }
  const tabs = ['chat', 'extrato', 'cartoes', 'relatorios', 'saldos', 'config'];
  
  tabs.forEach((n) => {
    const el = $('tab' + n.charAt(0).toUpperCase() + n.slice(1));
    const navBtn = $('nav' + n.charAt(0).toUpperCase() + n.slice(1));
    const isTarget = n === tab;

    if (el) {
      if (isTarget) {
        if (el.classList.contains('hidden')) el.style.animation = '';
        el.classList.remove('hidden');
        if (dir && el.animate) {
          el.style.animation = 'none';
          el.animate([{ transform: `translateX(${dir * 60}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'ease-out' });
        }
      } else {
        el.classList.add('hidden');
      }
    }

    if (navBtn) {
      navBtn.className = 'flex flex-col items-center gap-1 transition-all duration-200 ' + 
        (isTarget ? 'text-electric-400 font-medium scale-105' : 'text-slate-400 hover:text-slate-200');
    }
  });

  const inMais = ['relatorios', 'saldos', 'config'].includes(tab);
  $('navMais').className = 'flex flex-col items-center gap-1 transition-all duration-200 ' + (inMais ? 'text-electric-400 font-medium scale-105' : 'text-slate-400 hover:text-slate-200');
  $('moreSheet').classList.add('hidden');
  if (tab === 'chat') { renderHome(); fitChat(); }
  if (tab === 'relatorios') renderRelatorios();
  if (tab === 'cartoes') renderCartoes();
  if (tab === 'extrato') renderExtrato();
}

const shiftExtrato = n => { extratoOffset += n; renderExtrato(); };
const shiftFatura = n => { faturaOffset += n; renderCartoes(); };
const shiftRelatorio = n => { relatorioOffset += n; renderRelatorios(); };
function applyShortcut(text) { const i = $('userInput'); i.value = text; i.focus(); }

// ---------- Chat ----------
function handleSendMessage(e) {
  e.preventDefault();
  const text = $('userInput').value.trim();
  if (!text) return;
  pendingTransaction = null;
  addMessage(esc(text), 'user');
  $('userInput').value = '';
  parseAndProcessText(text);
}

function addMessage(html, sender) {
  const box = $('chatMessages');
  const div = document.createElement('div');
  if (sender === 'user') {
    div.className = 'flex justify-end';
    div.innerHTML = `<div class="bg-electric-500 text-white rounded-2xl rounded-tr-none px-3.5 py-2 max-w-[85%] text-xs shadow-md shadow-electric-500/20">${html}</div>`;
  } else {
    div.className = 'flex gap-2.5 items-start';
    div.innerHTML = `
      <div class="w-8 h-8 rounded-xl overflow-hidden border border-electric-500/30 shrink-0 mt-0.5">
        <img src="joaquim-logo.png" alt="Joaquim" class="w-full h-full object-cover">
      </div>
      <div class="bg-dark-card border border-dark-border rounded-2xl rounded-tl-none p-3.5 max-w-[88%] text-slate-200 leading-relaxed shadow-sm">${html}</div>`;
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

const wordRe = words => new RegExp('(^|[^\\p{L}\\p{N}])(' + words + ')(?![\\p{L}\\p{N}])', 'giu');
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Identificador de datas no texto (ontem, anteontem, dia X, etc)
function parseDateFromText(lowerText) {
  const now = new Date();
  const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
  if (/\banteontem\b/.test(lowerText)) return daysAgo(2);
  if (/\bontem\b/.test(lowerText)) return daysAgo(1);
  const m = lowerText.match(/\bdia\s+(\d{1,2})(?:\/(\d{1,2}))?\b/);
  if (m) {
    const day = parseInt(m[1]);
    if (day >= 1 && day <= 31) {
      const month = m[2] ? parseInt(m[2]) - 1 : now.getMonth();
      const clamp = (y, mo) => new Date(y, mo, Math.min(day, new Date(y, mo + 1, 0).getDate()));
      let d = clamp(now.getFullYear(), month);
      // "dia 28" dito no dia 5 quase sempre quer dizer o mês passado
      if (!m[2] && d > now) d = month === 0 ? clamp(now.getFullYear() - 1, 11) : clamp(now.getFullYear(), month - 1);
      return d;
    }
  }
  return now;
}

function parseAndProcessText(text) {
  let t = text;
  const lower = text.toLowerCase();

  // 1. Respostas para Consultas e Perguntas ao Joaquim
  if (/quanto gastei|qual o total|quanto tenho|meu saldo/.test(lower)) {
    processChatQuery(lower);
    return;
  }

  // Identificação de Data Relativa/Passada
  const targetDate = parseDateFromText(lower);
  t = t.replace(/\bdia\s+\d{1,2}(?:\/\d{1,2})?\b/gi, ' '); // tira "dia 10" do texto para não virar valor

  // 2. Identificação de Entrada / Receita (Ganho)
  const isIncome = /recebi|ganhei|sal[áa]rio|pix recebido/i.test(lower);

  const isRecurring = !isIncome && /por m[eê]s|mensal|todo m[eê]s|assinei|assinatura/i.test(lower);
  let installments = 1;
  const im = t.match(/(?:em\s*)?(\d{1,2})\s*x(?![\p{L}\d])/iu);
  if (im) { installments = Math.max(1, parseInt(im[1])); t = t.replace(im[0], ' '); }

  let m = t.match(/r\$\s*(\d[\d.,]*)/i), numStr;
  if (m) { numStr = m[1]; }
  else {
    const all = [...t.matchAll(/\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?/g)];
    m = all[all.length - 1];
    numStr = m ? m[0] : null;
  }
  const cents = numStr ? parseMoney(numStr) : 0;
  if (!cents) {
    addMessage("Não consegui identificar o valor. Tente algo como: <b>'Almoço 45 no crédito ontem'</b> ou <b>'Recebi 1500 dia 10'</b>.", 'assistant');
    return;
  }
  t = t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length);

  let cardObj = null;
  for (const c of cards) {
    const re = new RegExp('(^|[^\\p{L}\\p{N}])' + escRe(c.name) + '(?![\\p{L}\\p{N}])', 'iu');
    if (re.test(t)) { cardObj = c; t = t.replace(re, '$1 '); break; }
  }

  let method = null;
  if (/d[eé]bito/.test(lower)) method = 'Débito';
  else if (/\bpix\b/.test(lower)) method = 'PIX';
  else if (/cr[eé]dito|cart[aã]o/.test(lower) || installments > 1 || cardObj) method = 'Crédito';
  if (method === 'PIX' || method === 'Dinheiro') installments = 1;
  if (isIncome) { method = 'Entrada'; installments = 1; }
  if (isRecurring) { installments = 1; if (!method || method === 'PIX' && !/\bpix\b/.test(lower)) method = 'Crédito'; }

  // Remoção de termos comuns de preenchimento (incluindo palavras de tempo e 'reais')
  t = t.replace(wordRe('comprei|gastei|paguei|fui|recebi|ganhei|no|na|de|do|da|em|por|para|um|uma|crédito|credito|débito|debito|cartão|cartao|pix|r\\$|reais|assinei|assinatura|mensal|todo|m[eê]s|ontem|anteontem'), '$1');
  
  let description = t.replace(/\s+/g, ' ').trim();
  description = description ? description[0].toUpperCase() + description.slice(1) : (isIncome ? 'Entrada / Salário' : 'Gasto Geral');

  let category = isIncome ? 'Receita' : 'Geral';
  if (!isIncome) {
    if (/almoço|almoco|jantar|cafe|café|ifood|restaurante|comida|lanche|pizzaria/i.test(description)) category = 'Alimentação';
    else if (/uber|\b99\b|gasolina|combustivel|combustível|bus|passagem|estacionamento/i.test(description)) category = 'Transporte';
    else if (/mercado|compras|supermercado|açougue|acougue|padaria/i.test(description)) category = 'Mercado';
    else if (/netflix|spotify|disney|hbo|youtube|prime|deezer|assinatura/i.test(description) || isRecurring) category = 'Assinaturas';
  }

  const data = { description, cents, installments, category, method: method || 'PIX', cardObj, isIncome, recurring: isRecurring, targetDate };

  if ((data.method === 'Crédito' || data.method === 'Débito' || data.method === 'PIX' || data.method === 'Entrada') && !cardObj) {
    if (cards.length === 0) { addMessage('Cadastre um cartão na aba Faturas primeiro.', 'assistant'); return; }
    if (cards.length === 1) { data.cardObj = cards[0]; processFinalTransaction(data); return; }
    pendingTransaction = data;
    askWhichCard();
  } else {
    processFinalTransaction(data);
  }
}

// Função para responder a perguntas e consultas no Chat
function processChatQuery(query) {
  if (/saldo|quanto tenho/.test(query)) {
    const total = cards.reduce((a, c) => a + accountBalance(c), 0);
    addMessage(`Somando todas as contas, você tem <b class="text-electric-400">${brl(total)}</b>.`, 'assistant');
    return;
  }
  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const list = monthTransactions(0).list.filter(isExpense);
  const cat = customCategories.find(c => norm(query).includes(norm(c)));
  if (cat) {
    const total = list.filter(t => t.category === cat).reduce((a, t) => a + t.cents, 0);
    addMessage(`Em <b>${esc(cat)}</b> você gastou <b class="text-electric-400">${brl(total)}</b> este mês.`, 'assistant');
  } else {
    const total = list.reduce((a, t) => a + t.cents, 0);
    addMessage(`O total gasto neste mês é <b class="text-electric-400">${brl(total)}</b>.`, 'assistant');
  }
}

function askWhichCard() {
  const what = pendingTransaction.method !== 'Crédito' ? 'banco' : 'cartão';
  const inc = pendingTransaction.method === 'Entrada';
  addMessage(`
    <p class="mb-2 font-medium">${inc ? 'Em qual banco entrou' : 'Qual ' + what + ' você usou nesta compra de'} <b class="text-white">${brl(pendingTransaction.cents)}</b>?</p>
    <div class="flex flex-wrap gap-1.5 mt-2">
      ${cards.map(c => `<button onclick="selectCard('${c.id}')" class="bg-electric-500/20 border border-electric-500/40 text-electric-400 hover:bg-electric-500 hover:text-white px-3 py-1 rounded-xl font-semibold active:scale-95">${esc(c.name)}</button>`).join('')}
    </div>`, 'assistant');
}

function selectCard(cardId) {
  if (!pendingTransaction) { addMessage('Essa pergunta expirou. Envie o gasto novamente.', 'assistant'); return; }
  pendingTransaction.cardObj = cards.find(c => c.id === cardId);
  const data = pendingTransaction; pendingTransaction = null;
  processFinalTransaction(data);
}

// Variável global para guardar a última transação do chat
let lastChatGroupId = null;

function processFinalTransaction(d) {
  const baseDate = d.targetDate || new Date();
  const groupId = Date.now();
  lastChatGroupId = groupId; // Registra o ID para possibilitar o desfazer

  const base = Math.floor(d.cents / d.installments);
  const rest = d.cents - base * d.installments;
  if (!customCategories.includes(d.category) && d.category !== 'Receita') customCategories.push(d.category);
  let rid = null;
  if (d.recurring) {
    rid = uid();
    recurring.push({ id: rid, name: d.description, cents: d.cents, category: d.category, method: d.method, cardId: d.cardObj ? d.cardObj.id : null, day: baseDate.getDate(), generated: [monthKey(baseDate)] });
  }

  for (let i = 0; i < d.installments; i++) {
    transactions.unshift({
      id: groupId + i, groupId, total: d.installments, idx: i + 1,
      name: d.description, cents: base + (i === 0 ? rest : 0),
      category: d.category, method: d.method, cardId: d.cardObj ? d.cardObj.id : null,
      date: isoDate(addMonths(baseDate, i)), rid
    });
  }
  refresh();

  const cardInfo = d.cardObj ? ` (${esc(d.cardObj.name)})` : '';
  const parcel = d.installments > 1 ? ` em ${d.installments}x de ${brl(base)}` : '';
  let extra = d.recurring ? `<p class="text-[10px] text-slate-400">🔁 Recorrente: todo dia ${baseDate.getDate()}</p>` : '';
  if ((d.method === 'Débito' || d.method === 'PIX' || d.method === 'Entrada') && d.cardObj) extra += `<p class="text-[10px] text-slate-400">Saldo ${esc(d.cardObj.name)}: ${brl(accountBalance(d.cardObj))}</p>`;
  if (d.method === 'Crédito' && d.cardObj) extra += `<p class="text-[10px] text-slate-400">Fatura de ${monthLabel(invoiceKeyOf(baseDate, d.cardObj))}</p>`;

  addMessage(`
    <div class="border-l-2 border-electric-500 pl-2.5 py-0.5 space-y-1">
      <div class="flex justify-between items-center gap-2">
        <p class="font-bold text-electric-400 flex items-center gap-1.5 text-xs"><i class="fa-solid fa-circle-check"></i> Lançamento Registrado!</p>
        <button onclick="undoLastChatTransaction(${groupId})" class="text-[10px] bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white px-2 py-0.5 rounded-lg transition-all font-semibold active:scale-95 shrink-0"><i class="fa-solid fa-rotate-left"></i> Desfazer</button>
      </div>
      <p class="text-white font-semibold text-xs">${esc(d.description)} — <span class="text-electric-400">${brl(d.cents)}</span>${parcel}</p>
      <p class="text-[10px] text-slate-400">${d.category} • ${d.method}${cardInfo} • ${fmtDate(isoDate(baseDate))}</p>${extra}
    </div>`, 'assistant');
}

// Função para desfazer o lançamento efetuado pelo chat
function undoLastChatTransaction(groupId) {
  if (!groupId) return;
  const rids = transactions.filter(t => t.groupId === groupId && t.rid).map(t => t.rid);
  recurring = recurring.filter(r => !rids.includes(r.id));
  transactions = transactions.filter(t => t.groupId !== groupId);
  refresh();
  addMessage(`<p class="text-xs text-red-400 font-semibold"><i class="fa-solid fa-trash-can"></i> Lançamento desfeito com sucesso!</p>`, 'assistant');
}

// ---------- Edição de Lançamento ----------
function openEditModal(id, e) {
  if (e) e.stopPropagation();
  const t = transactions.find(x => x.id === id);
  if (!t) return;
  editingTransactionId = id;

  populateCategoryDropdowns();

  $('editNameInput').value = t.name;
  $('editValueInput').value = (t.cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  $('editCategorySelect').value = t.category || 'Geral';
  $('editMethodSelect').value = t.method || 'Crédito';

  const select = $('editCardSelect');
  select.innerHTML = cards.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  if (t.cardId) select.value = t.cardId;

  toggleEditCardSelect();
  $('editModal').classList.remove('hidden');
}

function closeEditModal() {
  $('editModal').classList.add('hidden');
  editingTransactionId = null;
}

function toggleEditCardSelect() {
  const method = $('editMethodSelect').value;
  const needCard = method !== 'Dinheiro';
  $('editCardContainer').style.display = needCard ? 'block' : 'none';
}

function saveEditedTransaction() {
  if (!editingTransactionId) return;
  const t = transactions.find(x => x.id === editingTransactionId);
  if (!t) return;

  const newName = $('editNameInput').value.trim();
  const newCents = parseMoney($('editValueInput').value.trim());
  const newCategory = $('editCategorySelect').value;
  const newMethod = $('editMethodSelect').value;
  const needCard = newMethod !== 'Dinheiro';
  const newCardId = needCard ? $('editCardSelect').value : null;

  if (!newName || newCents <= 0) {
    toast('Informe um nome e um valor válidos.');
    return;
  }

  const changes = { name: newName, cents: newCents, category: newCategory, method: newMethod, cardId: newCardId };
  if (t.total > 1) {
    pendingEdit = { id: t.id, changes };
    $('editScopeModal').classList.remove('hidden');
    return;
  }
  Object.assign(t, changes);
  refresh();
  closeEditModal();
}

let pendingEdit = null;

function closeEditScopeModal() {
  $('editScopeModal').classList.add('hidden');
  pendingEdit = null;
}

// scope: 'single' (só esta), 'next' (esta e as próximas) ou 'all' (todas as parcelas)
function applyEditScope(scope) {
  if (!pendingEdit) return;
  const base = transactions.find(x => x.id === pendingEdit.id);
  if (base) {
    transactions
      .filter(x => x.groupId === base.groupId && (scope === 'all' || x.id === base.id || (scope === 'next' && x.idx >= base.idx)))
      .forEach(x => Object.assign(x, pendingEdit.changes));
  }
  pendingEdit = null;
  $('editScopeModal').classList.add('hidden');
  refresh();
  closeEditModal();
}

// ---------- Exclusão ----------
const label = t => t.total > 1 ? `${t.name} (${t.idx}/${t.total})` : t.name;

function promptDelete(id, e) {
  if (e) e.stopPropagation();
  deletingTransaction = transactions.find(t => t.id === id);
  if (!deletingTransaction) return;
  const t = deletingTransaction;
  if (t.total > 1) {
    $('deleteModalMsg').innerHTML = `A compra <b>"${esc(t.name)}"</b> é parcelada em ${t.total}x. Como deseja cancelar?`;
    $('deleteModalOptions').innerHTML = `
      <button onclick="confirmDelete('single')" class="w-full bg-dark-input hover:bg-dark-border border border-dark-border text-white py-2.5 rounded-xl text-xs font-semibold">Excluir APENAS esta parcela (${t.idx}/${t.total})</button>
      <button onclick="confirmDelete('all')" class="w-full bg-red-600/20 hover:bg-red-600 border border-red-500/40 text-red-300 hover:text-white py-2.5 rounded-xl text-xs font-semibold">Excluir TODAS as parcelas desta compra</button>`;
  } else {
    $('deleteModalMsg').innerHTML = `Tem certeza que deseja excluir <b>"${esc(t.name)}"</b>?`;
    $('deleteModalOptions').innerHTML = `<button onclick="confirmDelete('single')" class="w-full bg-red-600 hover:bg-red-700 text-white py-2.5 rounded-xl text-xs font-semibold">Sim, Excluir Lançamento</button>`;
  }
  $('deleteModal').classList.remove('hidden');
}

function closeDeleteModal() { $('deleteModal').classList.add('hidden'); deletingTransaction = null; }

function confirmDelete(type) {
  const d = deletingTransaction; if (!d) return;
  if (type === 'all') {
    transactions = transactions.filter(t => t.groupId !== d.groupId);
  } else {
    transactions = transactions.filter(t => t.id !== d.id);
  }
  refresh(); closeDeleteModal();
}

// ---------- Extrato ----------
function monthTransactions(offset) {
  const key = shiftKey(monthKey(new Date()), offset);
  return { key, list: transactions.filter(t => t.date.startsWith(key)).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id) };
}

// Mapeamento de ícones e cores por categoria
// Mapeamento inteligente de logos/ícones por nome da compra e categoria
function getTransactionBrandIcon(name, cat) {
  const lower = (name || '').toLowerCase();

  // Logos/Marcas Específicas (FontAwesome Brands)
  if (lower.includes('uber')) return { icon: 'fa-brands fa-uber', bg: 'bg-black text-white' };
  if (lower.includes('ifood')) return { icon: 'fa-solid fa-utensils', bg: 'bg-red-500 text-white' };
  if (lower.includes('apple') || lower.includes('iphone') || lower.includes('macbook')) return { icon: 'fa-brands fa-apple', bg: 'bg-slate-900 text-white' };
  if (lower.includes('amazon')) return { icon: 'fa-brands fa-amazon', bg: 'bg-amber-500 text-slate-900' };
  if (lower.includes('netflix')) return { icon: 'fa-solid fa-film', bg: 'bg-red-600 text-white' };
  if (lower.includes('spotify')) return { icon: 'fa-brands fa-spotify', bg: 'bg-emerald-500 text-white' };
  if (lower.includes('steam')) return { icon: 'fa-brands fa-steam', bg: 'bg-slate-800 text-white' };
  if (lower.includes('cafeteria') || lower.includes('café') || lower.includes('cafe')) return { icon: 'fa-solid fa-mug-hot', bg: 'bg-amber-100 text-amber-700' };
  if (lower.includes('mcdonald') || lower.includes('mc')) return { icon: 'fa-solid fa-burger', bg: 'bg-yellow-400 text-red-600' };

  // Ícones por Categoria (Fallback)
  switch (cat) {
    case 'Alimentação': return { icon: 'fa-solid fa-utensils', bg: 'bg-amber-100 text-amber-600' };
    case 'Transporte': return { icon: 'fa-solid fa-car', bg: 'bg-blue-100 text-blue-600' };
    case 'Mercado': return { icon: 'fa-solid fa-cart-shopping', bg: 'bg-emerald-100 text-emerald-600' };
    case 'Receita': return { icon: 'fa-solid fa-arrow-down', bg: 'bg-emerald-100 text-emerald-600' };
    case 'Trabalho': return { icon: 'fa-solid fa-briefcase', bg: 'bg-purple-100 text-purple-600' };
    default: return { icon: 'fa-solid fa-bag-shopping', bg: 'bg-slate-100 text-slate-600' };
  }
}

// Formatação BRL no estilo grande com centavos menores (ex: R$ 394,50 -> R$ 394 e ,50 em fonte menor)
function fmtBigBrl(cents) {
  const full = (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const parts = full.split(',');
  return `R$ ${parts[0]}<span class="text-lg sm:text-xl font-normal text-slate-400 opacity-80">,${parts[1]}</span>`;
}

// Retorna cor e ícone característicos do banco/cartão
function getBankCardStyle(cardName) {
  const lower = (cardName || '').toLowerCase();
  if (lower.includes('nubank') || lower.includes('nu')) return { bg: 'bg-purple-600', icon: 'fa-credit-card' };
  if (lower.includes('itaú') || lower.includes('itau')) return { bg: 'bg-orange-500', icon: 'fa-building-columns' };
  if (lower.includes('inter')) return { bg: 'bg-amber-500', icon: 'fa-bolt' };
  if (lower.includes('bradesco')) return { bg: 'bg-red-600', icon: 'fa-building-columns' };
  if (lower.includes('santander')) return { bg: 'bg-red-700', icon: 'fa-fire' };
  if (lower.includes('c6')) return { bg: 'bg-slate-800', icon: 'fa-credit-card' };
  if (lower.includes('btg')) return { bg: 'bg-blue-900', icon: 'fa-shield' };
  return { bg: 'bg-electric-500', icon: 'fa-credit-card' };
}

// Transição fluida de expansão dos cartões ao clicar no stack
let cardsTransitioning = false;

function setNavActive(tab) {
  ['chat', 'extrato', 'cartoes', 'relatorios', 'saldos', 'config'].forEach(n => {
    const btn = $('nav' + n.charAt(0).toUpperCase() + n.slice(1));
    if (btn) btn.className = 'flex flex-col items-center gap-1 transition-all duration-200 ' +
      (n === tab ? 'text-electric-400 font-medium scale-105' : 'text-slate-400 hover:text-slate-200');
  });
}

// Transição: a tela do Extrato desliza para a esquerda, a das Faturas entra pela direita,
// e cada barrinha colorida cresce (voando) até virar o cartão correspondente.
function animateAndSwitchToCards() { switchTab('cartoes'); }

// forward=true: barrinhas do Extrato crescem até virar os cartões; forward=false: o inverso
function animateCards(forward) {
  const ext = $('tabExtrato'), car = $('tabCartoes'), main = document.querySelector('main');
  const A = forward ? ext : car, B = forward ? car : ext;
  const selPills = '#headerCardStack .mini-card-pill', selCards = '#cardsList [data-card-id]';
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let srcs = [...document.querySelectorAll(forward ? selPills : selCards)];
  if (!srcs.length || reduced || !ext.animate) { switchTab(forward ? 'cartoes' : 'extrato', 0, true); return; }
  cardsTransitioning = true;

  let clones = [], tgts = [];
  const cleanup = () => {
    A.getAnimations().forEach(a => a.cancel());
    B.getAnimations().forEach(a => a.cancel());
    A.classList.add('hidden');
    A.style.position = A.style.top = A.style.left = A.style.width = '';
    main.style.position = '';
    document.documentElement.style.overflowX = '';
    tgts.forEach(el => { el.style.transition = ''; el.style.opacity = ''; });
    clones.forEach(({ c }) => {
      const rm = () => c.remove();
      c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished.then(rm, rm);
    });
    srcs.forEach(p => { p.style.visibility = ''; });
    setNavActive(forward ? 'cartoes' : 'extrato');
    cardsTransitioning = false;
  };

  try {
    const from = srcs.map(p => p.getBoundingClientRect());
    const mainRect = main.getBoundingClientRect(), aRect = A.getBoundingClientRect();
    main.style.position = 'relative';
    Object.assign(A.style, { position: 'absolute', top: (aRect.top - mainRect.top) + 'px', left: (aRect.left - mainRect.left) + 'px', width: aRect.width + 'px' });
    if (forward) { expandedCardId = null; renderCartoes(); } else renderExtrato();
    B.style.animation = 'none';
    B.classList.remove('hidden');
    document.documentElement.style.overflowX = 'hidden';

    tgts = [...document.querySelectorAll(forward ? selCards : selPills)];
    const to = {};
    tgts.forEach(el => { el.style.transition = 'none'; el.style.opacity = '0'; to[el.dataset.cardId] = el.getBoundingClientRect(); });

    const pillR = '10px 0 0 10px', cardR = '24px';
    const pillS = '-4px 2px 10px rgba(0,0,0,.6)', cardS = '0 20px 25px -5px rgba(0,0,0,.5)';
    const [rf, rt, sf, st] = forward ? [pillR, cardR, pillS, cardS] : [cardR, pillR, cardS, pillS];
    clones = srcs.map((p, i) => {
      const t = to[p.dataset.cardId], f = from[i];
      if (!t) return null;
      const c = document.createElement('div');
      c.className = [...p.classList].filter(k => k.startsWith('bg-')).join(' ');
      Object.assign(c.style, { position: 'fixed', left: f.left + 'px', top: f.top + 'px', width: f.width + 'px', height: f.height + 'px', borderRadius: rf, zIndex: 40, pointerEvents: 'none', boxSizing: 'border-box' });
      document.body.appendChild(c);
      p.style.visibility = 'hidden';
      return { c, f, t, i };
    }).filter(Boolean);

    const ease = 'cubic-bezier(0.22, 1, 0.36, 1)';
    const anims = clones.map(({ c, f, t, i }) => c.animate([
      { left: f.left + 'px', top: f.top + 'px', width: f.width + 'px', height: f.height + 'px', borderRadius: rf, boxShadow: sf },
      { left: t.left + 'px', top: t.top + 'px', width: t.width + 'px', height: t.height + 'px', borderRadius: rt, boxShadow: st }
    ], { duration: 600, delay: i * 60, easing: ease, fill: 'both' }));
    const s = forward ? 1 : -1;
    anims.push(A.animate([{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${-35 * s}%)`, opacity: 0 }], { duration: 450, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' }));
    anims.push(B.animate([{ transform: `translateX(${45 * s}%)`, opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }], { duration: 550, easing: ease, fill: 'backwards' }));
    Promise.all(anims.map(a => a.finished)).then(cleanup, cleanup);
  } catch (e) {
    cleanup();
    switchTab(forward ? 'cartoes' : 'extrato', 0, true);
  }
}

// Renderiza o mini stack de cartões empilhados no topo
function renderHeaderCardStack() {
  const container = $('headerCardStack');
  if (!container) return;

  if (!cards.length) {
    container.innerHTML = `<span class="text-[9px] text-slate-500">Sem cartões</span>`;
    return;
  }

  container.innerHTML = cards.map((card, idx) => {
    const style = getBankCardStyle(card.name);
    return `
      <div class="mini-card-pill ${style.bg}" data-card-id="${card.id}" style="z-index: ${idx + 1};" title="${esc(card.name)}">
        <div class="flex justify-between items-center text-[8px] text-white/80">
          <i class="fa-solid ${style.icon}"></i>
        </div>
        <div class="text-[7px] font-bold text-white/90 truncate uppercase tracking-tighter">${esc(card.name)}</div>
      </div>
    `;
  }).join('');
}

function renderExtrato() {
  renderHeaderCardStack();

  const { key, list: monthList } = monthTransactions(extratoOffset);
  const q = normTxt($('extratoSearch') ? $('extratoSearch').value.trim() : '');
  const list = !q ? monthList : [...transactions].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id).filter(t => {
    const c = cards.find(x => x.id === t.cardId);
    return normTxt([t.name, t.category, t.method, c ? c.name : ''].join(' ')).includes(q);
  });
  const totalMonthCents = monthList.filter(isExpense).reduce((a, t) => a + t.cents, 0);

  $('extratoMonth').innerText = monthLabel(key);
  $('extratoCount').innerText = `${list.length} ${list.length === 1 ? 'lançamento' : 'lançamentos'}`;

  if ($('extratoHeaderTotal')) {
    $('extratoHeaderTotal').innerHTML = fmtBigBrl(totalMonthCents);
  }
  $('headerTotal').innerText = brl(totalMonthCents);

  if (!list.length) {
    $('transactionsList').innerHTML = `
      <div class="py-8 text-center space-y-2">
        <img src="joaquim-logo.png" alt="" class="w-16 h-16 rounded-full mx-auto">
        <p class="text-xs font-medium text-slate-400">${q ? 'Nada encontrado para essa busca.' : 'Nada por aqui ainda. Conta pro Joaquim o seu primeiro gasto, lá no Início!'}</p>
      </div>`;
    return;
  }

  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const dayLabel = iso => {
    const d = parseIso(iso), diff = Math.round((t0 - d) / 86400000);
    if (diff === 0) return 'Hoje';
    if (diff === 1) return 'Ontem';
    return d.toLocaleDateString('pt-BR', d.getFullYear() === t0.getFullYear() ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
  };
  const dayTotals = {};
  list.forEach(t => { if (isExpense(t)) dayTotals[t.date] = (dayTotals[t.date] || 0) + t.cents; });
  let out = '', lastDate = null;
  list.forEach(t => {
    if (t.date !== lastDate) {
      lastDate = t.date;
      out += `<div class="flex justify-between items-center px-2.5 pt-3 pb-1 text-[11px] font-bold text-slate-400 uppercase tracking-wide"><span>${dayLabel(t.date)}</span><span>${dayTotals[t.date] ? '- ' + brl(dayTotals[t.date]) : ''}</span></div>`;
    }
    const c = cards.find(x => x.id === t.cardId);
    const style = getTransactionBrandIcon(t.name, t.category);
    out += `
    <div onclick="openEditModal(${t.id}, event)" class="flex justify-between items-center p-2.5 rounded-2xl hover:bg-slate-50 transition-all cursor-pointer">
      <div class="flex items-center gap-3">
        <div class="icon-avatar ${style.bg} shadow-sm"><i class="${style.icon}"></i></div>
        <div>
          <span class="text-xs font-bold text-slate-800 block leading-tight font-inter">${esc(label(t))}</span>
          <span class="text-[10px] text-slate-400 font-medium">${esc(t.category)} • ${t.method}${c ? ' (' + esc(c.name) + ')' : ''}</span>
        </div>
      </div>
      <div class="flex items-center gap-2.5">
        <span class="text-xs font-extrabold ${t.method === 'Entrada' ? 'text-emerald-600' : 'text-slate-900'} font-inter">${t.method === 'Entrada' ? '+' : '-'} ${brl(t.cents)}</span>
        <button onclick="promptDelete(${t.id}, event)" class="text-slate-300 hover:text-red-500 p-1.5 transition-all"><i class="fa-solid fa-trash-can text-xs"></i></button>
      </div>
    </div>`;
  });
  $('transactionsList').innerHTML = out;
}

// ---------- Relatórios & Metas ----------
function openMetaModal() {
  populateCategoryDropdowns();
  $('metaModal').classList.remove('hidden');
  toggleNewCategoryInput();
}

function closeMetaModal() {
  $('metaModal').classList.add('hidden');
  $('metaValueInput').value = '';
  $('newCategoryInput').value = '';
  $('newCategoryContainer').classList.add('hidden');
}

function saveMetaCategory() {
  const selectVal = $('metaCategorySelect').value;
  let cat = selectVal;

  if (selectVal === '__NEW__') {
    cat = $('newCategoryInput').value.trim();
    if (!cat) {
      toast('Digite o nome da nova categoria.');
      return;
    }
    if (!customCategories.includes(cat)) {
      customCategories.push(cat);
      saveCategories();
      populateCategoryDropdowns();
    }
  }

  const val = parseMoney($('metaValueInput').value.trim());
  if (val > 0) {
    categoryMetas[cat] = val;
  } else {
    delete categoryMetas[cat];
  }

  refresh();
  closeMetaModal();
}

function renderRelatorios() {
  const { key, list: allList } = monthTransactions(relatorioOffset);
  const list = allList.filter(isExpense);
  $('relatorioMonth').innerText = monthLabel(key);

  const totalMonth = list.reduce((a, t) => a + t.cents, 0);

  const catTotals = {};
  list.forEach(t => { catTotals[t.category] = (catTotals[t.category] || 0) + t.cents; });

  const labels = Object.keys(catTotals);
  const dataValues = labels.map(l => catTotals[l] / 100);

  const canChart = typeof Chart !== 'undefined';
  const ctx = canChart ? $('categoryChart').getContext('2d') : null;
  if (myChart) myChart.destroy();

  if (!canChart) {
    myChart = null;
  } else if (labels.length === 0) {
    myChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Sem gastos'],
        datasets: [{ data: [1], backgroundColor: ['#334155'] }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
  } else {
    myChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
            labels: labels,
            datasets: [{
              data: dataValues,
              backgroundColor: [
                '#3b82f6', // Azul Elétrico
                '#f97316', // Laranja Vivo
                '#10b981', // Verde Esmeralda
                '#ec4899', // Rosa Pink
                '#eab308', // Amarelo
                '#8b5cf6', // Roxo Violeta
                '#ef4444', // Vermelho
                '#06b6d4', // Ciano
                '#a855f7', // Roxo Vivo
                '#14b8a6'  // Verde Água
              ],
              borderWidth: 0
            }]
          },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#94a3b8', font: { size: 10 } } }
        }
      }
    });
  }

  const insightsDiv = $('joaquimInsights');
  if (totalMonth === 0) {
    insightsDiv.innerHTML = `
      <div class="flex items-center gap-2 text-slate-400 text-xs">
        <i class="fa-solid fa-lightbulb text-yellow-400 text-sm"></i>
        <p>Nenhum lançamento no mês de <b>${monthLabel(key)}</b> para gerar dicas de economia.</p>
      </div>`;
  } else {
    let maxCat = '', maxVal = 0;
    for (const [c, v] of Object.entries(catTotals)) {
      if (v > maxVal) { maxVal = v; maxCat = c; }
    }
    const pct = Math.round((maxVal / totalMonth) * 100);
    insightsDiv.innerHTML = `
      <div class="flex items-start gap-2 text-xs">
        <i class="fa-solid fa-lightbulb text-yellow-400 text-sm mt-0.5 shrink-0"></i>
        <div class="space-y-1">
          <p class="font-bold text-white">Dica do Joaquim:</p>
          <p class="text-slate-300">Neste mês, a sua maior despesa foi em <b class="text-electric-400">${esc(maxCat)}</b>, representando <b class="text-white">${pct}%</b> do total gasto (${brl(maxVal)}).</p>
        </div>
      </div>`;
  }

  const metasDiv = $('metasProgressList');
  const allCatKeys = Array.from(new Set([...Object.keys(categoryMetas), ...Object.keys(catTotals)]));

  if (allCatKeys.length === 0) {
    metasDiv.innerHTML = `<p class="text-slate-500 text-center py-2">Nenhuma meta configurada.</p>`;
    return;
  }

  metasDiv.innerHTML = allCatKeys.map(cat => {
    const spent = catTotals[cat] || 0;
    const limit = categoryMetas[cat] || 0;
    const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
    const isOver = limit > 0 && spent > limit;

    return `
      <div class="space-y-1">
        <div class="flex justify-between items-center text-[11px]">
          <span class="font-semibold text-white">${esc(cat)}</span>
          <span class="text-slate-400">${brl(spent)} ${limit > 0 ? '/ ' + brl(limit) : '(sem limite)'}</span>
        </div>
        ${limit > 0 ? `
          <div class="w-full bg-dark-input rounded-full h-2 overflow-hidden">
            <div class="${isOver ? 'bg-red-500' : 'bg-electric-500'} h-2 rounded-full transition-all" style="width: ${pct}%"></div>
          </div>
          ${isOver ? `<p class="text-[9px] text-red-400 font-bold">⚠️ Limite ultrapassado em ${brl(spent - limit)}!</p>` : ''}
        ` : ''}
      </div>`;
  }).join('');
}

// ---------- Saldos ----------
function renderSaldos() {
  const total = cards.reduce((a, c) => a + accountBalance(c), 0);
  $('saldoTotal').innerText = brl(total);
  $('saldoTotal').className = 'text-2xl font-extrabold ' + (total < 0 ? 'text-red-400' : 'text-emerald-400');
  $('saldosList').innerHTML = !cards.length
    ? `<p class="text-xs text-slate-500 text-center py-4">Nenhuma conta cadastrada.</p>`
    : cards.map(card => {
      const bal = accountBalance(card);
      return `
      <div class="bg-dark-card border border-dark-border p-4 rounded-2xl shadow-md flex justify-between items-center">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-xl bg-electric-500/10 border border-electric-500/30 flex items-center justify-center text-electric-400"><i class="fa-solid fa-building-columns"></i></div>
          <div>
            <h3 class="text-xs font-bold text-white">${esc(card.name)}</h3>
            <span class="text-sm font-extrabold ${bal < 0 ? 'text-red-400' : 'text-emerald-400'}">${brl(bal)}</span>
          </div>
        </div>
        <button onclick="setBalance('${card.id}')" class="text-[10px] bg-dark-input border border-dark-border text-slate-300 hover:text-white px-2.5 py-1 rounded-lg font-semibold">Definir saldo</button>
      </div>`;
    }).join('');
}

// ---------- Faturas ----------
function toggleCardExpand(id) { expandedCardId = expandedCardId === id ? null : id; renderCartoes(); }

function renderCartoes() {
  $('faturaNav').innerText = faturaOffset === 0 ? 'Fatura aberta' : (faturaOffset > 0 ? `+${faturaOffset} mês` : `${faturaOffset} mês`);
  if (!cards.length) { $('cardsList').innerHTML = `<p class="text-xs text-slate-500 text-center py-4">Nenhum cartão cadastrado.</p>`; return; }

  $('cardsList').innerHTML = cards.map(card => {
    const key = shiftKey(openInvoiceKey(card), faturaOffset);
    const items = transactions.filter(t => t.cardId === card.id && t.method === 'Crédito' && invoiceKeyOf(parseIso(t.date), card) === key)
      .sort((a, b) => b.date.localeCompare(a.date));
    const total = items.reduce((a, t) => a + t.cents, 0);
    const open = expandedCardId === card.id;
    const style = getBankCardStyle(card.name);

    const list = !open ? '' : !items.length
      ? `<p class="text-[11px] text-slate-400 text-center border-t border-white/20 mt-3 pt-2">Fatura sem lançamentos neste mês.</p>`
      : `<div class="border-t border-white/20 mt-3 pt-3 space-y-2" onclick="event.stopPropagation()">
          <p class="text-[10px] uppercase font-bold text-white/70 tracking-wider">Lançamentos em ${monthLabel(key)}:</p>
          ${items.map(t => `
            <div onclick="openEditModal(${t.id}, event)" class="flex justify-between items-center text-xs py-1.5 border-b border-white/10 last:border-none cursor-pointer hover:bg-black/20 px-2 rounded-xl transition-all">
              <div>
                <span class="text-white font-semibold block flex items-center gap-1">${esc(label(t))}</span>
                <span class="text-[10px] text-white/70">${esc(t.category)} • ${fmtDate(t.date)}</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="font-bold text-white">${brl(t.cents)}</span>
                <button onclick="promptDelete(${t.id}, event)" class="text-white/60 hover:text-red-300 p-1"><i class="fa-solid fa-trash-can text-[11px]"></i></button>
              </div>
            </div>`).join('')}
        </div>`;

    return `
      <div data-card-id="${card.id}" onclick="toggleCardExpand('${card.id}')" class="${style.bg} p-5 rounded-3xl shadow-2xl cursor-pointer transition-all hover:scale-[1.01] text-white border border-white/10 space-y-4">
        <div class="flex justify-between items-start">
          <div>
            <span class="text-[10px] uppercase tracking-wider font-semibold opacity-80 block mb-0.5">Cartão de Crédito</span>
            <h3 class="text-lg font-extrabold font-inter tracking-tight flex items-center gap-2">
              ${esc(card.name)}
              <i class="fa-solid ${style.icon} text-sm opacity-90"></i>
            </h3>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-xs font-mono font-bold tracking-widest opacity-80">•••• ${card.id.slice(-4)}</span>
            <button onclick="event.stopPropagation(); openCardModal('${card.id}')" class="w-7 h-7 rounded-full bg-black/20 hover:bg-black/40 flex items-center justify-center text-[11px]"><i class="fa-solid fa-pen"></i></button>
          </div>
        </div>

        <div class="flex justify-between items-end">
          <div>
            <span class="text-[9px] uppercase tracking-wider block opacity-75">Fatura de ${monthLabel(key)}</span>
            <span class="text-2xl font-black font-inter">${brl(total)}</span>
          </div>
          <div class="text-right text-[10px] opacity-80 font-medium">
            <p>Fecha dia ${card.closingDay}</p>
            <p>Vence dia ${card.dueDay}</p>
          </div>
        </div>
        ${list}
      </div>`;
  }).join('');
}

// ---------- Gastos recorrentes ----------
function generateRecurring() {
  const now = new Date(), cur = monthKey(now);
  let changed = false;
  recurring.forEach(r => {
    let k = shiftKey(r.generated[0], 1);
    while (k <= cur) {
      if (!r.generated.includes(k)) {
        const [y, m] = k.split('-').map(Number);
        const d = new Date(y, m - 1, Math.min(r.day, new Date(y, m, 0).getDate()));
        if (d <= now) {
          const id = Date.now() + Math.floor(Math.random() * 1e6);
          transactions.unshift({ id, groupId: id, total: 1, idx: 1, name: r.name, cents: r.cents, category: r.category, method: r.method, cardId: r.cardId, date: isoDate(d), rid: r.id });
          r.generated.push(k); changed = true;
        }
      }
      k = shiftKey(k, 1);
    }
  });
  if (changed) save();
}

function renderRecurring() {
  const el = $('recurringList'); if (!el) return;
  el.innerHTML = !recurring.length
    ? `<p class="text-[11px] text-slate-500">Nenhum ainda. Diga no chat: "assinei Netflix por 32,90 por mês".</p>`
    : recurring.map(r => {
      const c = cards.find(x => x.id === r.cardId);
      return `<div class="flex justify-between items-center text-xs">
        <div><span class="text-white font-semibold block">${esc(r.name)}</span><span class="text-[10px] text-slate-400">${brl(r.cents)} • todo dia ${r.day}${c ? ' • ' + esc(c.name) : ''}</span></div>
        <button onclick="deleteRecurring('${r.id}')" class="text-slate-500 hover:text-red-400 p-1"><i class="fa-solid fa-trash-can text-xs"></i></button></div>`;
    }).join('');
}

function deleteRecurring(id) {
  const r = recurring.find(x => x.id === id); if (!r) return;
  if (!confirm(`Cancelar a recorrência "${r.name}"? Os lançamentos já feitos continuam no Extrato.`)) return;
  recurring = recurring.filter(x => x.id !== id);
  refresh();
}

// ---------- Previsão dos próximos meses ----------
let forecastPage = 0;
function shiftForecast(n) { forecastPage = Math.max(0, Math.min(5, forecastPage + n)); renderForecast(); }

// Mostra 2 meses por vez (até 12 meses à frente); as barras usam a mesma escala em todas as páginas
function renderForecast() {
  const el = $('forecastList'); if (!el) return;
  const cur = monthKey(new Date());
  const rows = Array.from({ length: 12 }, (_, i) => {
    const key = shiftKey(cur, i + 1);
    const fixed = transactions.filter(t => isExpense(t) && t.date.startsWith(key)).reduce((a, t) => a + t.cents, 0);
    const rec = recurring.filter(r => !r.generated.includes(key)).reduce((a, r) => a + r.cents, 0);
    return { key, fixed, rec, total: fixed + rec };
  });
  const max = Math.max(1, ...rows.map(r => r.total));
  $('fcPrev').style.opacity = forecastPage === 0 ? '.3' : '1';
  $('fcNext').style.opacity = forecastPage === 5 ? '.3' : '1';
  el.innerHTML = rows.slice(forecastPage * 2, forecastPage * 2 + 2).map(r => {
    const parts = [];
    if (r.fixed) parts.push(`${brl(r.fixed)} em parcelas e lançamentos`);
    if (r.rec) parts.push(`${brl(r.rec)} em recorrentes`);
    return `
    <div class="space-y-1">
      <div class="flex justify-between text-[11px]"><span class="text-white font-semibold">${monthLabel(r.key)}</span><span class="text-slate-400">${brl(r.total)}</span></div>
      <div class="w-full bg-dark-input rounded-full h-2 overflow-hidden"><div class="bg-electric-500 h-2 rounded-full transition-all" style="width:${Math.round(r.total / max * 100)}%"></div></div>
      <p class="text-[9px] text-slate-500">${parts.length ? parts.join(' • ') : 'Nada comprometido ainda'}</p>
    </div>`;
  }).join('');
}

// ---------- Avisos de vencimento & Pagamento de Faturas ----------
function renderAlerts() {
  const box = $('alertBox'); if (!box) return;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const items = [];
  cards.forEach(card => {
    [shiftKey(openInvoiceKey(card), -1), openInvoiceKey(card)].forEach(key => {
      if (paidInvoices.includes(card.id + '|' + key)) return;
      const total = transactions.filter(t => t.cardId === card.id && t.method === 'Crédito' && invoiceKeyOf(parseIso(t.date), card) === key).reduce((a, t) => a + t.cents, 0);
      if (total <= 0) return;
      const [y, m] = key.split('-').map(Number);
      const dm = m - 1 + (card.dueDay > card.closingDay ? 0 : 1);
      const due = new Date(y, dm, Math.min(card.dueDay, new Date(y, dm + 1, 0).getDate()));
      const days = Math.round((due - today) / 86400000);
      if (days <= 3 && days >= -10) items.push({ card, key, total, days });
    });
  });
  box.innerHTML = items.map(i => {
    const when = i.days < 0 ? `venceu há ${-i.days} dia${i.days === -1 ? '' : 's'}` : i.days === 0 ? 'vence hoje' : i.days === 1 ? 'vence amanhã' : `vence em ${i.days} dias`;
    const late = i.days < 0;
    return `<div class="flex items-center justify-between gap-2 ${late ? 'bg-red-500/15 border-red-500/40' : 'bg-yellow-500/10 border-yellow-500/30'} border rounded-2xl px-3 py-2 text-[11px]">
      <span class="text-white"><i class="fa-solid fa-bell ${late ? 'text-red-400' : 'text-yellow-400'}"></i> Fatura <b>${esc(i.card.name)}</b> ${when}: <b>${brl(i.total)}</b></span>
      <button onclick="markPaid('${i.card.id}','${i.key}')" class="shrink-0 bg-electric-500 text-white px-2.5 py-1 rounded-lg font-semibold hover:bg-electric-600 transition-all">Paguei</button></div>`;
  }).join('');
}

function markPaid(cardId, key) {
  const cardPaid = cards.find(c => c.id === cardId);
  if (!cardPaid) return;

  const total = transactions
    .filter(t => t.cardId === cardId && t.method === 'Crédito' && invoiceKeyOf(parseIso(t.date), cardPaid) === key)
    .reduce((a, t) => a + t.cents, 0);

  if (total <= 0) {
    paidInvoices.push(cardId + '|' + key);
    save();
    renderAlerts();
    return;
  }

  const cardOptions = cards.map(c => `• ${c.name}`).join('\n');
  const chosenName = cards.length === 1 ? cardPaid.name : prompt(
    `A fatura do ${cardPaid.name} (${monthLabel(key)}) no valor de ${brl(total)} foi paga por qual conta?\n\nDigite o nome de uma das suas contas:\n${cardOptions}`,
    cardPaid.name
  );

  if (!chosenName) return;

  const sourceAccount = cards.find(c => normTxt(c.name) === normTxt(chosenName.trim())) || cardPaid;

  const paymentId = Date.now();
  transactions.unshift({
    id: paymentId,
    groupId: paymentId,
    total: 1,
    idx: 1,
    name: `Pagamento Fatura ${cardPaid.name} (${monthLabel(key)})`,
    cents: total,
    category: 'Pagamento de Fatura',
    method: 'Débito',
    cardId: sourceAccount.id,
    date: isoDate(new Date())
  });

  paidInvoices.push(cardId + '|' + key);
  refresh();
  toast(`Pagamento de ${brl(total)} registrado com sucesso! O valor foi descontado da conta ${sourceAccount.name}.`);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) { generateRecurring(); renderAll(); } });

// ---------- Trocar de aba arrastando para o lado ----------
(() => {
  const order = ['chat', 'extrato', 'cartoes', 'relatorios', 'saldos', 'config'];
  let sx = 0, sy = 0, ok = false;
  document.addEventListener('touchstart', e => {
    const t = e.touches[0]; sx = t.clientX; sy = t.clientY;
    ok = !e.target.closest('.no-scrollbar, input, select, textarea, canvas, [id$="Modal"]');
  }, { passive: true });
  document.addEventListener('touchend', e => {
    if (!ok || cardsTransitioning || document.querySelector('[id$="Modal"]:not(.hidden)')) return;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return;
    const cur = order.findIndex(n => !$('tab' + n[0].toUpperCase() + n.slice(1)).classList.contains('hidden'));
    const next = order[cur + (dx < 0 ? 1 : -1)];
    if (next) switchTab(next, dx < 0 ? 1 : -1);
  }, { passive: true });
})();

// ---------- Avisos rápidos (no lugar da caixa do navegador) ----------
function toast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.className = 'fixed left-1/2 top-20 z-[300] w-[90%] max-w-xs bg-dark-card border border-electric-500/40 text-white text-xs font-semibold px-4 py-3 rounded-2xl shadow-2xl text-center';
  document.body.appendChild(t);
  t.animate([{ opacity: 0, transform: 'translate(-50%,-8px)' }, { opacity: 1, transform: 'translate(-50%,0)' }], { duration: 200, fill: 'forwards' });
  setTimeout(() => t.animate([{ opacity: 1, transform: 'translate(-50%,0)' }, { opacity: 0, transform: 'translate(-50%,0)' }], { duration: 300, fill: 'forwards' }).finished.then(() => t.remove()), 2800);
}

// ---------- Tela inicial: resumo ----------
function renderHome() {
  const el = $('homeSummary'); if (!el) return;
  const saldo = cards.reduce((a, c) => a + accountBalance(c), 0);
  const gasto = monthTransactions(0).list.filter(isExpense).reduce((a, t) => a + t.cents, 0);
  let abertas = 0, prox = null;
  cards.forEach(card => {
    const key = openInvoiceKey(card);
    const tot = transactions.filter(t => t.cardId === card.id && t.method === 'Crédito' && invoiceKeyOf(parseIso(t.date), card) === key).reduce((a, t) => a + t.cents, 0);
    abertas += tot;
    if (tot > 0) {
      const [y, m] = key.split('-').map(Number);
      const dm = m - 1 + (card.dueDay > card.closingDay ? 0 : 1);
      const due = new Date(y, dm, Math.min(card.dueDay, new Date(y, dm + 1, 0).getDate()));
      if (!prox || due < prox.due) prox = { card, due };
    }
  });
  el.innerHTML = `
    <div class="grid grid-cols-2 gap-2">
      <div class="bg-dark-card border border-dark-border rounded-2xl p-3"><span class="block text-[10px] text-slate-400 uppercase font-bold">Saldo total</span><span class="text-base font-extrabold ${saldo < 0 ? 'text-red-400' : 'text-emerald-400'}">${brl(saldo)}</span></div>
      <div class="bg-dark-card border border-dark-border rounded-2xl p-3"><span class="block text-[10px] text-slate-400 uppercase font-bold">Gasto do mês</span><span class="text-base font-extrabold text-white">${brl(gasto)}</span></div>
    </div>
    <div class="bg-dark-card border border-dark-border rounded-2xl px-3 py-2 flex justify-between items-center text-[11px]">
      <span class="text-slate-400"><i class="fa-solid fa-credit-card text-electric-400"></i> Faturas abertas <b class="text-white">${brl(abertas)}</b></span>
      <span class="text-slate-400">${prox ? esc(prox.card.name) + ' vence ' + pad(prox.due.getDate()) + '/' + pad(prox.due.getMonth() + 1) : 'Sem vencimentos'}</span>
    </div>`;
}

// ---------- Caixinhas de economia ----------
let goals = loadJSON('finances_goals', []);
let goalEditing = null;
const goalSaved = g => g.movs.reduce((a, m) => a + m.cents, 0);
const goalMovSum = card => goals.reduce((a, g) => a + g.movs.filter(m => m.cardId === card.id).reduce((s, m) => s + m.cents, 0), 0);

function openGoalModal(mode, id) {
  goalEditing = id || null;
  const isNew = mode === 'new';
  $('goalTitle').innerText = isNew ? 'Nova caixinha' : goals.find(g => g.id === id).name;
  ['goalNewFields', 'goalNewBtns'].forEach(i => $(i).classList.toggle('hidden', !isNew));
  ['goalMoveFields', 'goalMoveBtns'].forEach(i => $(i).classList.toggle('hidden', isNew));
  $('goalBank').innerHTML = cards.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  ['goalName', 'goalTarget', 'goalAmount'].forEach(i => { $(i).value = ''; });
  $('goalModal').classList.remove('hidden');
}
function closeGoalModal() { $('goalModal').classList.add('hidden'); }
function saveGoal() {
  const name = $('goalName').value.trim();
  if (!name) { toast('Dê um nome para a caixinha.'); return; }
  goals.push({ id: uid(), name, target: parseMoney($('goalTarget').value.trim()), movs: [] });
  refresh(); closeGoalModal();
}
// sign = 1 guarda (sai da conta); sign = -1 retira (volta para a conta)
function moveGoal(sign) {
  const g = goals.find(x => x.id === goalEditing);
  const cents = parseMoney($('goalAmount').value.trim()), cardId = $('goalBank').value;
  if (!g || !cents || !cardId) { toast('Informe o valor e a conta.'); return; }
  if (sign < 0 && cents > goalSaved(g)) { toast('A caixinha não tem esse valor.'); return; }
  g.movs.push({ date: isoDate(new Date()), cents: sign * cents, cardId });
  refresh(); closeGoalModal();
}
function deleteGoal(id) {
  const g = goals.find(x => x.id === id); if (!g) return;
  if (!confirm(`Excluir a caixinha "${g.name}"? O valor guardado volta para as contas.`)) return;
  goals = goals.filter(x => x.id !== id); refresh();
}
function renderGoals() {
  const el = $('goalsList'); if (!el) return;
  el.innerHTML = !goals.length
    ? `<p class="text-[11px] text-slate-500">Crie uma caixinha para uma reserva ou uma viagem. O dinheiro guardado sai do saldo da conta escolhida.</p>`
    : goals.map(g => {
      const s = goalSaved(g), pct = g.target ? Math.min(100, Math.round(s / g.target * 100)) : 0;
      return `<div class="space-y-1.5">
        <div class="flex justify-between items-center text-xs"><span class="text-white font-semibold">${esc(g.name)}</span><span class="text-slate-400">${brl(s)}${g.target ? ' / ' + brl(g.target) : ''}</span></div>
        ${g.target ? `<div class="w-full bg-dark-input rounded-full h-2 overflow-hidden"><div class="bg-emerald-500 h-2 rounded-full transition-all" style="width:${pct}%"></div></div>` : ''}
        <div class="flex gap-2">
          <button onclick="openGoalModal('move','${g.id}')" class="flex-1 bg-dark-input border border-dark-border text-slate-200 py-1.5 rounded-xl text-[11px] font-semibold">Guardar / retirar</button>
          <button onclick="deleteGoal('${g.id}')" class="text-slate-500 hover:text-red-400 px-2"><i class="fa-solid fa-trash-can text-xs"></i></button>
        </div></div>`;
    }).join('');
}

// ---------- Abertura (logo) e senha ----------
const PIN_KEY = 'finances_pin';
const hashPin = s => { let h = 5381; const x = 'joaquim:' + s; for (let i = 0; i < x.length; i++) h = ((h << 5) + h + x.charCodeAt(i)) >>> 0; return String(h); };
let pinMode = 'unlock', pinBuf = '', pinFirst = '';

function drawPin() {
  $('pinDots').innerHTML = [0, 1, 2, 3].map(i => `<span class="w-3.5 h-3.5 rounded-full border border-electric-400 ${i < pinBuf.length ? 'bg-electric-400' : ''}"></span>`).join('');
}
function pinShow(mode, msg) {
  const s = $('lockScreen');
  s.getAnimations().forEach(a => a.cancel());
  pinMode = mode; pinBuf = ''; pinFirst = '';
  $('pinMsg').innerText = msg;
  $('pinCancel').classList.toggle('hidden', mode === 'unlock');
  $('pinBox').classList.remove('hidden');
  s.classList.remove('hidden');
  drawPin();
}
function pinHide() {
  const s = $('lockScreen');
  s.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, fill: 'forwards' }).finished.then(() => s.classList.add('hidden'));
}
function pinKey(k) {
  if (k === '<') pinBuf = pinBuf.slice(0, -1); else if (pinBuf.length < 4) pinBuf += k;
  drawPin();
  if (pinBuf.length === 4) setTimeout(pinSubmit, 120);
}
function pinSubmit() {
  const stored = localStorage.getItem(PIN_KEY);
  if (pinMode === 'unlock' || pinMode === 'remove') {
    if (hashPin(pinBuf) === stored) {
      if (pinMode === 'remove') { localStorage.removeItem(PIN_KEY); toast('Senha removida.'); renderSecurity(); }
      pinHide();
    } else {
      pinBuf = ''; $('pinMsg').innerText = 'Senha incorreta. Tente de novo.'; drawPin();
      $('pinDots').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }], { duration: 250 });
    }
  } else if (pinMode === 'set') {
    pinFirst = pinBuf; pinBuf = ''; pinMode = 'confirm'; $('pinMsg').innerText = 'Repita a senha para confirmar'; drawPin();
  } else if (pinMode === 'confirm') {
    if (pinBuf === pinFirst) { localStorage.setItem(PIN_KEY, hashPin(pinBuf)); toast('Senha definida!'); renderSecurity(); pinHide(); }
    else { pinMode = 'set'; pinBuf = ''; pinFirst = ''; $('pinMsg').innerText = 'As senhas não batem. Digite a nova senha'; drawPin(); }
  }
}
function renderSecurity() {
  const el = $('securityBox'); if (!el) return;
  const has = !!localStorage.getItem(PIN_KEY);
  const b = 'flex-1 bg-dark-input border border-dark-border text-slate-200 py-2 rounded-xl text-xs font-semibold hover:bg-dark-border';
  el.innerHTML = `<p class="text-[11px] text-slate-400">${has ? 'O app pede a senha toda vez que abre.' : 'Proteja o app com uma senha de 4 dígitos.'} É uma tranca simples contra olhares curiosos; não substitui a senha do celular.</p>
    <div class="flex gap-2"><button onclick="pinShow('set','Escolha uma senha de 4 dígitos')" class="${b}">${has ? 'Trocar senha' : 'Definir senha'}</button>${has ? `<button onclick="pinShow('remove','Digite a senha atual para remover')" class="${b}">Remover</button>` : ''}</div>`;
}
function startLock() {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '<'];
  $('pinPad').innerHTML = keys.map(k => !k ? '<span></span>' : `<button onclick="pinKey('${k}')" class="h-14 rounded-2xl bg-dark-card border border-dark-border text-white text-lg font-bold active:scale-95">${k === '<' ? '<i class="fa-solid fa-delete-left"></i>' : k}</button>`).join('');
  const logo = $('lockLogo');
  if (logo.animate) logo.animate([{ opacity: 0, transform: 'scale(.85)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 600, easing: 'ease-out' });
  setTimeout(() => { if (localStorage.getItem(PIN_KEY)) pinShow('unlock', 'Digite sua senha'); else pinHide(); }, 1500);
}

// ---------- Ajusta a altura do chat à tela real do celular ----------
function fitChat() {
  const p = $('tabChat'), hd = document.querySelector('header'), nv = document.querySelector('nav'), al = $('alertBox');
  if (!p || !hd || !nv) return;
  const alertH = al && al.offsetHeight ? al.offsetHeight + 12 : 0;
  const h = window.innerHeight - hd.offsetHeight - nv.offsetHeight - alertH - 16 - 12;
  p.style.height = Math.max(300, h) + 'px';
}
window.addEventListener('resize', fitChat);
window.addEventListener('orientationchange', fitChat);
window.addEventListener('load', fitChat);

// ---------- App instalável (PWA) ----------
if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) navigator.serviceWorker.register('sw.js').catch(() => {});

// ---------- Backup & Configurações ----------
function exportBackup() {
  const data = {
    version: '2.0',
    exportDate: new Date().toISOString(),
    transactions,
    cards,
    categoryMetas,
    customCategories,
    recurring,
    goals
  };
  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `joaquim_finance_backup_${isoDate(new Date())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCSV() {
  const q = v => '"' + String(v).replace(/"/g, '""') + '"';
  const rows = [['Data', 'Descrição', 'Parcela', 'Categoria', 'Pagamento', 'Banco/Cartão', 'Valor']];
  [...transactions].sort((a, b) => a.date.localeCompare(b.date)).forEach(t => {
    const c = cards.find(x => x.id === t.cardId);
    const val = ((t.method === 'Entrada' ? t.cents : -t.cents) / 100).toFixed(2).replace('.', ',');
    rows.push([fmtDate(t.date), t.name, t.total > 1 ? `${t.idx}/${t.total}` : '', t.category, t.method, c ? c.name : '', val]);
  });
  const blob = new Blob(['\ufeff' + rows.map(r => r.map(q).join(';')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `joaquim_gastos_${isoDate(new Date())}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importBackup(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.transactions && data.cards) {
        if (!confirm('Isso substitui os dados atuais pelos do backup. Continuar?')) { event.target.value = ''; return; }
        transactions = data.transactions.map(migrate);
        cards = data.cards;
        cards.forEach(c => { if (typeof c.balance !== 'number') c.balance = 0; });
        if (data.categoryMetas) categoryMetas = data.categoryMetas;
        if (data.customCategories) customCategories = data.customCategories;
        if (Array.isArray(data.recurring)) recurring = data.recurring;
        if (Array.isArray(data.goals)) goals = data.goals;
        refresh();
        toast('Backup restaurado com sucesso!');
        event.target.value = '';
      } else {
        toast('Ficheiro de backup inválido.');
      }
    } catch (err) {
      toast('Erro ao ler o ficheiro de backup.');
    }
  };
  reader.readAsText(file);
}

function resetAllData() {
  if (confirm('Tem a certeza de que deseja apagar TODOS os dados? Esta ação não pode ser desfeita.')) {
    localStorage.clear();
    location.reload();
  }
}