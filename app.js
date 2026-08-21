const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
const state = { pdfBytes: null, pdfDocument: null, pageCount: 0, pages: [], marginScale: 1, activePage: 1, meta: null, theme: 'light' };

const $ = (selector) => document.querySelector(selector);
const homeView = $('#home-view');
const workspaceView = $('#workspace-view');
const pdfInput = $('#pdf-input');
const hamshInput = $('#hamsh-input');
const canvas = $('#pdf-canvas');
const context = canvas.getContext('2d');
const sideEditor = $('#side-editor');
const bottomEditor = $('#bottom-editor');
let pdfjs;
let toastTimer;

async function getPdfJs() {
  if (!pdfjs) {
    pdfjs = await import(PDFJS_URL);
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
  }
  return pdfjs;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3200);
}
function showError(message) { const el = $('#workspace-error'); el.textContent = message; el.hidden = false; }
function clearError() { $('#workspace-error').hidden = true; }
function setLoading(loading) { $('#loading-state').hidden = !loading; }
function baseName(filename) { return filename.replace(/\.pdf$/i, '') || 'مذكرة'; }

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  const isDark = state.theme === 'dark';
  document.querySelectorAll('.theme-toggle').forEach((button) => {
    button.textContent = isDark ? '☀️' : '🌙';
    button.setAttribute('aria-pressed', String(isDark));
  });
}

const DIVIDER_COLORS = [
  { name: 'خمري', hex: '#d66c55' },
  { name: 'أزرق غامق', hex: '#1e3a5f' },
  { name: 'بني غامق', hex: '#5d4037' },
  { name: 'بنفسجي غامق', hex: '#4a148c' },
  { name: 'أسود', hex: '#111111' }
];
function sanitizeDivider(value) { return value && Number.isInteger(value.colorIndex) && value.colorIndex >= 0 && value.colorIndex < DIVIDER_COLORS.length ? { colorIndex: value.colorIndex } : null; }

function defaultPages(count) { return Array.from({ length: count }, (_, index) => ({ pageNumber: index + 1, sideMargin: '', bottomMargin: '', divider: null })); }
function cleanHtml(value) {
  const doc = new DOMParser().parseFromString(value || '', 'text/html');
  const allowed = new Set(['P', 'BR', 'STRONG', 'B', 'UL', 'OL', 'LI', 'SPAN']);
  const sanitize = (node) => {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) return;
      if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); return; }
      // Chrome creates DIV elements for new lines in contenteditable areas.
      // Store them as paragraphs so moving between pages cannot collapse lines.
      if (child.tagName === 'DIV') {
        const paragraph = doc.createElement('p');
        while (child.firstChild) paragraph.append(child.firstChild);
        child.replaceWith(paragraph);
        sanitize(paragraph);
        return;
      }
      if (child.tagName === 'FONT') {
        const span = doc.createElement('span');
        const size = child.getAttribute('size');
        const fontSizeMap = { '1': '2', '2': '2', '3': '3', '4': '4', '5': '4', '6': '4', '7': '4' };
        if (fontSizeMap[size]) span.dataset.fontSize = fontSizeMap[size];
        while (child.firstChild) span.append(child.firstChild);
        child.replaceWith(span);
        sanitize(span);
        return;
      }
      if (!allowed.has(child.tagName)) {
        const fragment = doc.createDocumentFragment();
        while (child.firstChild) fragment.append(child.firstChild);
        child.replaceWith(fragment);
        sanitize(node);
        return;
      }
      [...child.attributes].forEach((attribute) => {
        if (child.tagName !== 'SPAN' || attribute.name !== 'data-font-size' || !['2', '3', '4'].includes(attribute.value)) child.removeAttribute(attribute.name);
      });
      sanitize(child);
    });
  };
  sanitize(doc.body);

  // Flatten nested spans with data-font-size: keep innermost, remove outer wrappers
  const flattenFontSizeSpans = (node) => {
    [...node.querySelectorAll('span[data-font-size]')].forEach((span) => {
      let current = span;
      while ((current = current.parentElement) && current.tagName === 'SPAN' && current.dataset.fontSize) {
        // Move children of inner span to outer, then remove inner
        while (span.firstChild) current.appendChild(span.firstChild);
        span.remove();
        break;
      }
    });
  };
  flattenFontSizeSpans(doc.body);

  return doc.body.innerHTML;
}
function captureEditors() {
  if (!state.pages.length) return;
  const page = state.pages[state.activePage - 1];
  page.sideMargin = cleanHtml(sideEditor.innerHTML);
  page.bottomMargin = cleanHtml(bottomEditor.innerHTML);
}
function fillEditors() {
  const page = state.pages[state.activePage - 1];
  sideEditor.innerHTML = page?.sideMargin || '';
  bottomEditor.innerHTML = page?.bottomMargin || '';
}
function updateControls() {
  $('#page-number').textContent = state.activePage;
  $('#page-count').textContent = state.pageCount;
  $('#previous-page').disabled = state.activePage === 1;
  $('#next-page').disabled = state.activePage === state.pageCount;
  document.querySelectorAll('.scale-button').forEach((button) => button.classList.toggle('is-active', Number(button.dataset.scale) === state.marginScale));
  $('#reading-desk').className = `reading-desk scale-${state.marginScale}`;
  const page = state.pages[state.activePage - 1];
  $('#divider-button').classList.toggle('is-active', !!page?.divider);
  const ribbon = $('#side-divider');
  if (page?.divider) { ribbon.hidden = false; ribbon.style.background = DIVIDER_COLORS[page.divider.colorIndex].hex; }
  else ribbon.hidden = true;
  const select = $('#divider-select');
  const dividers = state.pages.filter((p) => p.divider);
  select.hidden = !dividers.length;
  select.innerHTML = '<option value="" disabled selected>الفواصل</option>' + dividers.map((p, index) => `<option value="${p.pageNumber}">فاصل ${index + 1} — ص ${p.pageNumber}</option>`).join('');
}

async function renderPage() {
  setLoading(true); clearError();
  try {
    const page = await state.pdfDocument.getPage(state.activePage);
    const viewport = page.getViewport({ scale: 1.45 });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: context, viewport }).promise;
    fillEditors(); updateControls();
  } catch (error) { showError('تعذّر عرض هذه الصفحة. جرّب فتح الملف من جديد.'); console.error(error); }
  finally { setLoading(false); }
}

async function loadPdf(bytes) {
  const lib = await getPdfJs();
  state.pdfDocument?.destroy();
  state.pdfDocument = await lib.getDocument({ data: bytes.slice(0) }).promise;
  state.pageCount = state.pdfDocument.numPages;
}
function showWorkspace() { homeView.hidden = true; workspaceView.hidden = false; }
function showHome() { workspaceView.hidden = true; homeView.hidden = false; }

async function createNote(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { showToast('اختر ملف PDF صالحًا.'); return; }
  setLoading(true);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await loadPdf(bytes);
    state.pdfBytes = bytes;
    state.pages = defaultPages(state.pageCount);
    state.marginScale = 1; state.activePage = 1;
    state.meta = { title: baseName(file.name), originalFileName: file.name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    $('#document-title').textContent = state.meta.title;
    showWorkspace(); await renderPage();
  } catch (error) { console.error(error); showToast('تعذّر فتح الملف. تأكد من أنه PDF غير محمي بكلمة مرور.'); }
  finally { setLoading(false); pdfInput.value = ''; }
}
function bytesToBase64(bytes) { let binary = ''; const chunk = 0x8000; for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk)); return btoa(binary); }
function base64ToBytes(value) { const binary = atob(value); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }
function validateHamsh(data) {
  if (!data || data.app !== 'hamesh' || data.formatVersion !== '1.0') throw new Error('صيغة ملف المذكرة غير مدعومة.');
  if (![1, 2, 3, 4].includes(data.marginScale) || !data.pdf?.data || !Number.isInteger(data.pdf?.pageCount) || !Array.isArray(data.pages)) throw new Error('بيانات ملف المذكرة غير مكتملة أو معطوبة.');
  if (data.pages.length !== data.pdf.pageCount || !data.pages.every((page, i) => page.pageNumber === i + 1)) throw new Error('صفحات المذكرة لا تطابق المستند الأصلي.');
}
async function openHamsh(file) {
  if (!file) return;
  setLoading(true);
  try {
    const data = JSON.parse(await file.text()); validateHamsh(data);
    const bytes = base64ToBytes(data.pdf.data); await loadPdf(bytes);
    if (state.pageCount !== data.pdf.pageCount) throw new Error('عدد الصفحات لا يطابق ملف PDF المحفوظ.');
    state.pdfBytes = bytes; state.marginScale = data.marginScale;
    state.pages = data.pages.map((page) => ({ ...page, sideMargin: cleanHtml(page.sideMargin), bottomMargin: cleanHtml(page.bottomMargin), divider: sanitizeDivider(page.divider) }));
    state.activePage = Number.isInteger(data.viewState?.activePage) && data.viewState.activePage >= 1 && data.viewState.activePage <= state.pageCount ? data.viewState.activePage : 1;
    state.meta = data.meta || {}; state.meta.title ||= baseName(state.meta.originalFileName || file.name);
    $('#document-title').textContent = state.meta.title;
    showWorkspace(); await renderPage();
  } catch (error) { console.error(error); showToast(error.message || 'تعذّر فتح ملف المذكرة.'); }
  finally { setLoading(false); hamshInput.value = ''; }
}
function saveNote() {
  captureEditors();
  state.meta.updatedAt = new Date().toISOString();
  const payload = { formatVersion: '1.0', app: 'hamesh', meta: state.meta, marginScale: state.marginScale, viewState: { activePage: state.activePage }, pdf: { data: bytesToBase64(state.pdfBytes), pageCount: state.pageCount }, pages: state.pages };
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/octet-stream' })); link.download = `${baseName(state.meta.originalFileName || state.meta.title)}.hamsh`; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000); showToast('تم حفظ المذكرة وتنزيلها.');
}

function htmlToMarkdown(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const convertNode = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const childrenContent = Array.from(node.childNodes).map(convertNode).join('');
    switch (node.tagName) {
      case 'STRONG':
      case 'B':
        return `**${childrenContent}**`;
      case 'P':
        return `${childrenContent}\n\n`;
      case 'BR':
        return '\n';
      case 'UL':
      case 'OL':
        return `${childrenContent}\n`;
      case 'LI':
        if (node.parentElement && node.parentElement.tagName === 'OL') {
          const index = Array.from(node.parentElement.children).indexOf(node) + 1;
          return `${index}. ${childrenContent.trim()}\n`;
        }
        return `- ${childrenContent.trim()}\n`;
      case 'SPAN':
        return childrenContent;
      default:
        return childrenContent;
    }
  };
  return Array.from(doc.body.childNodes).map(convertNode).join('').trim();
}

function exportMarkdown() {
  captureEditors();
  const title = state.meta?.title || baseName(state.meta?.originalFileName || 'مذكرة');
  const pagesWithNotes = state.pages.filter((page) => {
    const side = htmlToMarkdown(page.sideMargin);
    const bottom = htmlToMarkdown(page.bottomMargin);
    return page.divider || side.length > 0 || bottom.length > 0;
  });

  if (pagesWithNotes.length === 0) {
    showToast('لا توجد هوامش مكتوبة للتصدير.');
    return;
  }

  const lines = [`# ${title}`, ''];
  pagesWithNotes.forEach((page) => {
    lines.push(`## [${page.pageNumber}]`);
    if (page.divider) lines.push(`## فاصل (${DIVIDER_COLORS[page.divider.colorIndex].name})`);
    const side = htmlToMarkdown(page.sideMargin);
    const bottom = htmlToMarkdown(page.bottomMargin);
    if (side) lines.push(side);
    if (bottom) lines.push(bottom);
    lines.push('');
  });
  lines.push('#هامش ¦ abonjm970.github.io/hamesh');

  const content = lines.join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
  link.download = `${title}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  showToast('تم تصدير الهوامش إلى ملف Markdown.');
}

const PDFLIB_URL = './pdf-lib.min.js';
const EXPORT_LAYOUT = { sideWidth: 490, bottomHeight: 415, padTop: 38, padX: 23, padBottom: 20, linePitch: 32, lineOffset: 30, renderScale: 2, ptRatio: 0.75 };
const EXPORT_COLORS = { paper: '#fffef9', rule: '#c6d1cc', divider: '#e6e6dc', ink: '#243d42', label: '#d66c55' };
const EXPORT_FONT_SIZE = 21;
let pdfLibPromise;
function loadPdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = PDFLIB_URL;
      script.onload = () => resolve(window.PDFLib);
      script.onerror = () => { pdfLibPromise = null; reject(new Error('تعذّر تحميل مكتبة PDF.')); };
      document.head.append(script);
    });
  }
  return pdfLibPromise;
}
function setLoadingMessage(message) {
  const el = $('#loading-state');
  if (el.lastChild && el.lastChild.nodeType === Node.TEXT_NODE) el.lastChild.textContent = message;
  else el.append(message);
}
function setHeaderDisabled(disabled) {
  ['#export-pdf-button', '#export-button', '#save-button'].forEach((selector) => { $(selector).disabled = disabled; });
}

function parseNoteBlocks(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const blocks = [];
  const walkInline = (node, bold, segs) => {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) { if (child.textContent) segs.push({ text: child.textContent, bold }); return; }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      if (child.tagName === 'BR') { segs.push({ text: '\n', bold }); return; }
      walkInline(child, bold || child.tagName === 'STRONG' || child.tagName === 'B', segs);
    });
  };
  const pushBlock = (segs, marker) => blocks.push({ segs, marker });
  [...doc.body.childNodes].forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent.trim()) pushBlock([{ text: node.textContent, bold: false }], '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === 'UL' || node.tagName === 'OL') {
      [...node.children].forEach((li, index) => {
        const segs = [];
        walkInline(li, false, segs);
        pushBlock(segs, node.tagName === 'UL' ? '•' : `${index + 1}.`);
      });
    } else {
      const segs = [];
      walkInline(node, false, segs);
      pushBlock(segs, '');
    }
  });
  return blocks.length ? blocks : [{ segs: [], marker: '' }];
}

function setNoteFont(ctx, bold) { ctx.font = `${bold ? '700' : '400'} ${EXPORT_FONT_SIZE}px "Noto Naskh Arabic"`; }

function layoutNoteLines(ctx, blocks, maxWidth) {
  const lines = [];
  const spaceWidth = ctx.measureText(' ').width;
  blocks.forEach((block) => {
    const indent = block.marker ? 20 : 0;
    const avail = maxWidth - indent;
    if (!block.segs.length || !block.segs.some((seg) => seg.text.trim())) { lines.push({ tokens: [], marker: block.marker, indent }); return; }
    const tokens = [];
    block.segs.forEach((seg) => {
      seg.text.split('\n').forEach((part, partIndex) => {
        if (partIndex > 0) tokens.push({ br: true });
        part.split(/\s+/).filter(Boolean).forEach((word) => tokens.push({ text: word, bold: seg.bold }));
      });
    });
    let lineTokens = [], lineWidth = 0;
    let isFirstLine = true;
    const flush = () => { lines.push({ tokens: lineTokens, marker: isFirstLine ? block.marker : null, indent }); lineTokens = []; lineWidth = 0; isFirstLine = false; };
    tokens.forEach((token) => {
      if (token.br) { flush(); return; }
      setNoteFont(ctx, token.bold);
      const wordWidth = ctx.measureText(token.text).width;
      if (lineTokens.length && lineWidth + spaceWidth + wordWidth > avail) { flush(); }
      if (lineTokens.length) { lineTokens.push({ text: ' ', bold: token.bold }); lineWidth += spaceWidth; }
      lineTokens.push(token);
      lineWidth += wordWidth;
    });
    if (lineTokens.length) lines.push({ tokens: lineTokens, marker: isFirstLine ? block.marker : null, indent });
  });
  return lines;
}

function drawNoteLines(ctx, lines, rightEdge, top, width, height) {
  ctx.textAlign = 'right';
  ctx.direction = 'rtl';
  ctx.fillStyle = EXPORT_COLORS.ink;
  ctx.textBaseline = 'alphabetic';
  let y = top;
  for (const line of lines) {
    if (y + EXPORT_LAYOUT.linePitch > top + height) break;
    const baseline = y + 23;
    let edge = rightEdge;
    if (line.marker) {
      ctx.font = `400 ${EXPORT_FONT_SIZE}px "Noto Naskh Arabic"`;
      ctx.fillText(line.marker, edge, baseline);
      edge -= line.indent;
    }
    for (let i = 0; i < line.tokens.length; i++) {
      const token = line.tokens[i];
      setNoteFont(ctx, token.bold);
      const tokenWidth = ctx.measureText(token.text).width;
      ctx.fillText(token.text, edge, baseline);
      edge -= tokenWidth;
    }
    y += EXPORT_LAYOUT.linePitch;
  }
}

function drawMarginPanel(ctx, x, y, width, height, label, html) {
  ctx.fillStyle = EXPORT_COLORS.paper;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = EXPORT_COLORS.rule;
  ctx.lineWidth = 1;
  for (let offset = EXPORT_LAYOUT.lineOffset; offset < height - EXPORT_LAYOUT.padBottom; offset += EXPORT_LAYOUT.linePitch) {
    ctx.beginPath();
    ctx.moveTo(x, y + offset + 0.5);
    ctx.lineTo(x + width, y + offset + 0.5);
    ctx.stroke();
  }
  ctx.fillStyle = EXPORT_COLORS.label;
  ctx.font = '700 14px "IBM Plex Sans Arabic"';
  try { ctx.letterSpacing = '1px'; } catch (_) {}
  ctx.textAlign = 'right';
  ctx.direction = 'rtl';
  ctx.fillText(label, x + width - 21, y + 26);
  try { ctx.letterSpacing = '0px'; } catch (_) {}
  const blocks = parseNoteBlocks(html);
  ctx.font = `400 ${EXPORT_FONT_SIZE}px "Noto Naskh Arabic"`;
  const lines = layoutNoteLines(ctx, blocks, width - EXPORT_LAYOUT.padX * 2);
  drawNoteLines(ctx, lines, x + width - EXPORT_LAYOUT.padX, y + EXPORT_LAYOUT.padTop, width - EXPORT_LAYOUT.padX * 2, height - EXPORT_LAYOUT.padTop - EXPORT_LAYOUT.padBottom);
}

function drawDividerRibbon(ctx, x, y, colorHex) {
  ctx.fillStyle = colorHex;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 22, y);
  ctx.lineTo(x + 22, y + 52);
  ctx.lineTo(x + 11, y + 40);
  ctx.lineTo(x, y + 52);
  ctx.closePath();
  ctx.fill();
}

async function renderCompositePage(pdfPage, pageState) {
  const viewport = pdfPage.getViewport({ scale: EXPORT_LAYOUT.renderScale });
  const pageCanvas = document.createElement('canvas');
  pageCanvas.width = Math.floor(viewport.width);
  pageCanvas.height = Math.floor(viewport.height);
  await pdfPage.render({ canvasContext: pageCanvas.getContext('2d'), viewport }).promise;

  const composite = document.createElement('canvas');
  composite.width = pageCanvas.width + EXPORT_LAYOUT.sideWidth;
  composite.height = pageCanvas.height + EXPORT_LAYOUT.bottomHeight;
  const ctx = composite.getContext('2d');
  ctx.fillStyle = EXPORT_COLORS.paper;
  ctx.fillRect(0, 0, composite.width, composite.height);
  ctx.drawImage(pageCanvas, 0, 0);

  drawMarginPanel(ctx, pageCanvas.width, 0, EXPORT_LAYOUT.sideWidth, pageCanvas.height, 'هامش الصفحة', pageState.sideMargin);
  drawMarginPanel(ctx, 0, pageCanvas.height, composite.width, EXPORT_LAYOUT.bottomHeight, 'تدوين إضافي', pageState.bottomMargin);

  ctx.strokeStyle = EXPORT_COLORS.divider;
  ctx.beginPath();
  ctx.moveTo(pageCanvas.width + 0.5, 0);
  ctx.lineTo(pageCanvas.width + 0.5, pageCanvas.height);
  ctx.moveTo(0, pageCanvas.height + 0.5);
  ctx.lineTo(composite.width, pageCanvas.height + 0.5);
  ctx.stroke();

  if (pageState.divider) drawDividerRibbon(ctx, pageCanvas.width + 24, 0, DIVIDER_COLORS[pageState.divider.colorIndex].hex);

  return composite;
}

async function exportPdf() {
  if (!state.pdfDocument || !state.pages.length) return;
  captureEditors();
  setHeaderDisabled(true);
  setLoading(true);
  try {
    await Promise.all([
      document.fonts.load(`400 ${EXPORT_FONT_SIZE}px "Noto Naskh Arabic"`),
      document.fonts.load(`700 ${EXPORT_FONT_SIZE}px "Noto Naskh Arabic"`),
      document.fonts.load('700 14px "IBM Plex Sans Arabic"'),
    ]);
    setLoadingMessage('جارٍ تجهيز مكتبة التصدير…');
    const { PDFDocument } = await loadPdfLib();
    const out = await PDFDocument.create();
    for (let pageNumber = 1; pageNumber <= state.pageCount; pageNumber++) {
      setLoadingMessage(`جارٍ تصدير الصفحة ${pageNumber} من ${state.pageCount}…`);
      const pdfPage = await state.pdfDocument.getPage(pageNumber);
      const composite = await renderCompositePage(pdfPage, state.pages[pageNumber - 1]);
      const image = await out.embedPng(composite.toDataURL('image/png'));
      const page = out.addPage([composite.width * EXPORT_LAYOUT.ptRatio, composite.height * EXPORT_LAYOUT.ptRatio]);
      page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    }
    setLoadingMessage('جارٍ تجهيز الملف…');
    const bytes = await out.save();
    const title = state.meta?.title || baseName(state.meta?.originalFileName || 'مذكرة');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    link.download = `${title}.pdf`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showToast('تم تصدير المستند مع الهوامش إلى ملف PDF.');
  } catch (error) { console.error(error); showToast(error.message || 'تعذّر تصدير ملف PDF.'); }
  finally { setLoading(false); setLoadingMessage(''); setHeaderDisabled(false); }
}

$('#new-note-button').addEventListener('click', () => pdfInput.click());
$('#open-note-button').addEventListener('click', () => hamshInput.click());
pdfInput.addEventListener('change', () => createNote(pdfInput.files[0]));
hamshInput.addEventListener('change', () => openHamsh(hamshInput.files[0]));
$('#previous-page').addEventListener('click', async () => { if (state.activePage > 1) { captureEditors(); state.activePage--; await renderPage(); } });
$('#next-page').addEventListener('click', async () => { if (state.activePage < state.pageCount) { captureEditors(); state.activePage++; await renderPage(); } });
document.querySelectorAll('.scale-button').forEach((button) => button.addEventListener('click', () => { state.marginScale = Number(button.dataset.scale); updateControls(); }));
document.querySelectorAll('.format-button[data-command]').forEach((button) => button.addEventListener('mousedown', (event) => { event.preventDefault(); document.execCommand(button.dataset.command, false); captureEditors(); }));
document.querySelectorAll('.font-size-button').forEach((button) => button.addEventListener('mousedown', (event) => {
  event.preventDefault();
  document.execCommand('fontSize', false, button.dataset.fontSize);
  document.querySelectorAll('.font-size-button').forEach((control) => control.classList.toggle('is-active', control === button));
  captureEditors();
}));
$('#divider-button').addEventListener('click', () => {
  const page = state.pages[state.activePage - 1];
  if (!page) return;
  if (page.divider) {
    page.divider = null;
  } else {
    const used = state.pages.filter((p) => p.divider).length;
    page.divider = { colorIndex: used % DIVIDER_COLORS.length };
    showToast(`تم وضع فاصل بلون ${DIVIDER_COLORS[page.divider.colorIndex].name}.`);
  }
  updateControls();
});
$('#divider-select').addEventListener('change', async (event) => {
  const target = Number(event.target.value);
  if (!target || target === state.activePage) return;
  captureEditors();
  state.activePage = target;
  await renderPage();
});
$('#export-pdf-button').addEventListener('click', exportPdf);
$('#export-button').addEventListener('click', exportMarkdown);
$('#save-button').addEventListener('click', saveNote);
$('#back-button').addEventListener('click', () => { if (confirm('العودة للبداية تُغلق المذكرة الحالية غير المحفوظة. هل تريد المتابعة؟')) showHome(); });
document.querySelectorAll('.theme-toggle').forEach((button) => button.addEventListener('click', () => { state.theme = state.theme === 'light' ? 'dark' : 'light'; applyTheme(); }));
applyTheme();
window.addEventListener('beforeunload', (event) => { if (workspaceView.hidden === false) { event.preventDefault(); event.returnValue = ''; } });

if ('serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => console.error('Service Worker registration failed:', error));
  });
}
