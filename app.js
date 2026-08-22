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
let navigationBusy = false;
let renderGeneration = 0;
let renderingBusy = false;
function setRenderingBusy(busy) { renderingBusy = busy; updateControls(); }

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
      if (child.nodeType === Node.TEXT_NODE) {
        // Zero-width spaces are placeholders inserted when a font size is
        // applied to a collapsed caret; they must not leak into saved notes.
        if (child.textContent.includes('\u200B')) child.textContent = child.textContent.replace(/\u200B/g, '');
        return;
      }
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

  // Unwrap nested spans with data-font-size while preserving every change of
  // size: adjacent segments may legitimately carry different sizes, so a
  // boundary is kept wherever the nested span's size differs from its
  // wrapper's; only redundant (same-size) nesting is merged. Invalid sizes
  // are already stripped by sanitize(), leaving only '2', '3' or '4'.
  const flattenFontSizeSpans = (root) => {
    let nested;
    while ((nested = root.querySelector('span[data-font-size] span[data-font-size]'))) {
      const wrapper = nested.parentElement;
      const parent = wrapper.parentNode;
      if (nested.dataset.fontSize === wrapper.dataset.fontSize) {
        while (nested.firstChild) wrapper.insertBefore(nested.firstChild, nested);
        nested.remove();
        continue;
      }
      const size = wrapper.dataset.fontSize;
      while (wrapper.firstChild) {
        const child = wrapper.firstChild;
        if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'SPAN' && child.dataset.fontSize && child.dataset.fontSize !== size) {
          parent.insertBefore(child, wrapper);
        } else {
          const run = doc.createElement('span');
          run.dataset.fontSize = size;
          while (wrapper.firstChild && !(wrapper.firstChild.nodeType === Node.ELEMENT_NODE && wrapper.firstChild.tagName === 'SPAN' && wrapper.firstChild.dataset.fontSize && wrapper.firstChild.dataset.fontSize !== size)) {
            run.append(wrapper.firstChild);
          }
          parent.insertBefore(run, wrapper);
        }
      }
      wrapper.remove();
    }
  };
  flattenFontSizeSpans(doc.body);

  // Drop size spans left empty (e.g. a size applied to a caret where nothing
  // was typed) so they cannot persist as invisible placeholders.
  doc.body.querySelectorAll('span[data-font-size]').forEach((span) => {
    if (!span.textContent && !span.querySelector('br')) span.remove();
  });

  return doc.body.innerHTML;
}
function captureEditors() {
  if (!state.pages.length) return;
  const page = state.pages[state.activePage - 1];
  page.sideMargin = cleanHtml(sideEditor.innerHTML);
  page.bottomMargin = cleanHtml(bottomEditor.innerHTML);
}
function fillEditors() {
  // Any saved selection references nodes this rewrite is about to destroy.
  savedSelection = null;
  const page = state.pages[state.activePage - 1];
  sideEditor.innerHTML = page?.sideMargin || '';
  bottomEditor.innerHTML = page?.bottomMargin || '';
}
function updateControls() {
  $('#page-number').textContent = state.activePage;
  $('#page-count').textContent = state.pageCount;
  $('#previous-page').disabled = navigationBusy || state.activePage === 1;
  $('#next-page').disabled = navigationBusy || state.activePage === state.pageCount;
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

const BASE_SCALE = 1.45;

async function renderPage(targetPage) {
  const generation = ++renderGeneration;
  setRenderingBusy(true);
  setLoading(true); clearError();
  try {
    const page = await state.pdfDocument.getPage(targetPage ?? state.activePage);
    if (generation !== renderGeneration) return null;
    const viewport = page.getViewport({ scale: BASE_SCALE });
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.maxWidth = '100%';
    canvas.style.width = '';
    canvas.style.height = '';
    await page.render({ canvasContext: context, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    if (generation !== renderGeneration) return null;
    fillEditors(); updateControls();
    return true;
  } catch (error) {
    if (generation !== renderGeneration) return null;
    showError('تعذّر عرض هذه الصفحة. جرّب فتح الملف من جديد.');
    fillEditors(); updateControls();
    console.error(error); return false;
  }
  finally { setLoading(false); setRenderingBusy(false); }
}

async function navigateTo(targetPage) {
  if (navigationBusy || !state.pdfDocument || !state.pages.length) return;
  const target = Math.floor(Number(targetPage));
  if (!Number.isInteger(target) || target < 1 || target > state.pageCount || target === state.activePage) return;
  captureEditors();
  navigationBusy = true;
  updateControls();
  try {
    const rendered = await renderPage(target);
    if (rendered === false) throw new Error('render-failed');
    state.activePage = target;
    fillEditors();
  } catch (error) {
    showToast('تعذّر عرض الصفحة المطلوبة.');
  } finally {
    navigationBusy = false;
    updateControls();
  }
}

async function loadPdf(bytes) {
  const lib = await getPdfJs();
  return await lib.getDocument({ data: bytes.slice(0) }).promise;
}
function showWorkspace() { homeView.hidden = true; workspaceView.hidden = false; }
function showHome() { workspaceView.hidden = true; homeView.hidden = false; flushPendingSwReload(); }

async function createNote(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { showToast('اختر ملف PDF صالحًا.'); return; }
  setLoading(true);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdfDocument = await loadPdf(bytes);
    state.pdfDocument?.destroy();
    state.pdfDocument = pdfDocument; state.pageCount = pdfDocument.numPages;
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
  if (typeof data.meta !== 'object' || data.meta === null || Array.isArray(data.meta)) throw new Error('بيانات المذكرة التعريفية معطوبة.');
}
async function openHamsh(file) {
  if (!file) return;
  setLoading(true);
  try {
    let data;
    try { data = JSON.parse(await file.text()); }
    catch (_) { throw new Error('الملف ليس مذكرة صالحة.'); }
    validateHamsh(data);
    let bytes;
    try { bytes = base64ToBytes(data.pdf.data); }
    catch (_) { throw new Error('بيانات PDF داخل المذكرة معطوبة.'); }
    const pdfDocument = await loadPdf(bytes);
    if (pdfDocument.numPages !== data.pdf.pageCount) throw new Error('عدد الصفحات لا يطابق ملف PDF المحفوظ.');
    const pages = data.pages.map((page) => ({ ...page, sideMargin: cleanHtml(page.sideMargin), bottomMargin: cleanHtml(page.bottomMargin), divider: sanitizeDivider(page.divider) }));
    const meta = { ...data.meta };
    meta.title = typeof meta.title === 'string' && meta.title.trim() ? meta.title : baseName(typeof meta.originalFileName === 'string' && meta.originalFileName ? meta.originalFileName : file.name);
    state.pdfDocument?.destroy();
    state.pdfDocument = pdfDocument; state.pageCount = pdfDocument.numPages;
    state.pdfBytes = bytes; state.marginScale = data.marginScale;
    state.pages = pages; state.meta = meta;
    state.activePage = Number.isInteger(data.viewState?.activePage) && data.viewState.activePage >= 1 && data.viewState.activePage <= state.pageCount ? data.viewState.activePage : 1;
    $('#document-title').textContent = state.meta.title;
    showWorkspace(); await renderPage();
  } catch (error) { console.error(error); showToast(typeof error.message === 'string' && error.message ? error.message : 'تعذّر فتح ملف المذكرة.'); }
  finally { setLoading(false); hamshInput.value = ''; }
}
function saveNote() {
  captureEditors();
  state.meta.updatedAt = new Date().toISOString();
  const payload = { formatVersion: '1.0', app: 'hamesh', meta: state.meta, marginScale: state.marginScale, viewState: { activePage: state.activePage }, pdf: { data: bytesToBase64(state.pdfBytes), pageCount: state.pageCount }, pages: state.pages };
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/octet-stream' })); link.download = `${baseName(state.meta.originalFileName || state.meta.title)}.hamsh`; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000); showToast('تم حفظ المذكرة وتنزيلها.'); flushPendingSwReload();
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
const BRAND_URL = 'https://abonjm970.github.io/hamesh';
const BRAND_COLORS = { paper: '#fffef9', petrol: '#12333a', coral: '#d66c55' };
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

function drawBrandLogo(ctx, x, y, size) {
  const scale = size / 64;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.fillStyle = BRAND_COLORS.petrol;
  ctx.beginPath();
  ctx.roundRect(0, 0, 64, 64, 14);
  ctx.fill();
  ctx.strokeStyle = BRAND_COLORS.coral;
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(18, 45);
  ctx.lineTo(35, 17);
  ctx.moveTo(30, 48);
  ctx.lineTo(47, 20);
  ctx.stroke();
  ctx.restore();
}

function renderBrandingPage(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BRAND_COLORS.paper;
  ctx.fillRect(0, 0, width, height);

  const logoSize = Math.round(height * 0.16);
  const nameFontSize = Math.round(logoSize * 0.56);
  const urlFontSize = 20;
  const gapLogoName = 40;
  const gapNameUrl = 26;
  const nameHeight = Math.round(nameFontSize * 1.15);
  const totalHeight = logoSize + gapLogoName + nameHeight + gapNameUrl + urlFontSize;
  const top = Math.round((height - totalHeight) / 2);

  drawBrandLogo(ctx, (width - logoSize) / 2, top, logoSize);

  const nameTop = top + logoSize + gapLogoName + nameFontSize * 0.85;
  ctx.fillStyle = BRAND_COLORS.petrol;
  ctx.font = `700 ${nameFontSize}px "El Messiri"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.direction = 'rtl';
  ctx.fillText('هامش', width / 2, nameTop);

  const urlBaseline = nameTop + gapNameUrl + urlFontSize * 0.8;
  ctx.fillStyle = BRAND_COLORS.coral;
  ctx.font = `500 ${urlFontSize}px "IBM Plex Sans Arabic"`;
  ctx.direction = 'ltr';
  ctx.fillText('abonjm970.github.io/hamesh', width / 2, urlBaseline);

  return { canvas, linkRect: { x: (width - logoSize) / 2, y: top, w: logoSize, h: totalHeight } };
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

function setExportOverlay(active) {
  let overlay = $('#export-overlay');
  if (active) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'export-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      document.body.append(overlay);
    }
  } else if (overlay) overlay.remove();
}
function setExportUiLocked(locked) {
  ['#workspace-view', '#home-view'].forEach((selector) => {
    const el = document.querySelector(selector);
    if (el) el.inert = locked;
  });
}
async function exportPdf() {
  if (!state.pdfDocument || !state.pages.length) return;
  captureEditors();
  const pdfDocument = state.pdfDocument;
  const pagesSnapshot = state.pages;
  const snapshotPageCount = state.pageCount;
  setHeaderDisabled(true);
  setExportOverlay(true);
  setExportUiLocked(true);
  setLoading(true);
  setLoadingMessage('جارٍ تصدير PDF…');
  try {
    await Promise.all([
      document.fonts.load(`400 ${EXPORT_FONT_SIZE}px "Noto Naskh Arabic"`),
      document.fonts.load(`700 ${EXPORT_FONT_SIZE}px "Noto Naskh Arabic"`),
      document.fonts.load('700 14px "IBM Plex Sans Arabic"'),
      document.fonts.load('500 20px "IBM Plex Sans Arabic"').catch(() => {}),
      document.fonts.load('700 64px "El Messiri"').catch(() => {}),
    ]);
    setLoadingMessage('جارٍ تجهيز مكتبة التصدير…');
    const { PDFDocument, PDFName, PDFString } = await loadPdfLib();
    const out = await PDFDocument.create();
    let lastCompositeWidth = 0;
    let lastCompositeHeight = 0;
    for (let pageNumber = 1; pageNumber <= snapshotPageCount; pageNumber++) {
      setLoadingMessage(`جارٍ تصدير الصفحة ${pageNumber} من ${snapshotPageCount}…`);
      const pdfPage = await pdfDocument.getPage(pageNumber);
      const composite = await renderCompositePage(pdfPage, pagesSnapshot[pageNumber - 1]);
      lastCompositeWidth = composite.width;
      lastCompositeHeight = composite.height;
      const image = await out.embedPng(composite.toDataURL('image/png'));
      const page = out.addPage([composite.width * EXPORT_LAYOUT.ptRatio, composite.height * EXPORT_LAYOUT.ptRatio]);
      page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    }
    setLoadingMessage('جارٍ إضافة الصفحة الختامية…');
    const brand = renderBrandingPage(lastCompositeWidth, lastCompositeHeight);
    const brandImage = await out.embedPng(brand.canvas.toDataURL('image/png'));
    const brandPage = out.addPage([brand.canvas.width * EXPORT_LAYOUT.ptRatio, brand.canvas.height * EXPORT_LAYOUT.ptRatio]);
    brandPage.drawImage(brandImage, { x: 0, y: 0, width: brandPage.getWidth(), height: brandPage.getHeight() });
    const pt = EXPORT_LAYOUT.ptRatio;
    const rect = brand.linkRect;
    const annotRef = out.context.register(out.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [rect.x * pt, (brand.canvas.height - rect.y - rect.h) * pt, (rect.x + rect.w) * pt, (brand.canvas.height - rect.y) * pt],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(BRAND_URL) },
    }));
    brandPage.node.set(PDFName.of('Annots'), out.context.obj([annotRef]));
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
  finally { setLoading(false); setLoadingMessage(''); setHeaderDisabled(false); setExportOverlay(false); setExportUiLocked(false); }
}

$('#new-note-button').addEventListener('click', () => pdfInput.click());
$('#open-note-button').addEventListener('click', () => hamshInput.click());
pdfInput.addEventListener('change', () => createNote(pdfInput.files[0]));
hamshInput.addEventListener('change', () => openHamsh(hamshInput.files[0]));
$('#previous-page').addEventListener('click', () => { void navigateTo(state.activePage - 1); });
$('#next-page').addEventListener('click', () => { void navigateTo(state.activePage + 1); });
document.querySelectorAll('.scale-button').forEach((button) => button.addEventListener('click', () => { state.marginScale = Number(button.dataset.scale); updateControls(); }));
let savedSelection = null;
function storeEditorSelection() {
  const selection = window.getSelection();
  const node = selection.anchorNode;
  if (!node || !selection.rangeCount) return;
  const editor = sideEditor.contains(node) ? sideEditor : bottomEditor.contains(node) ? bottomEditor : null;
  if (!editor) return;
  savedSelection = { editor, range: selection.getRangeAt(0).cloneRange() };
}
function applyFormat(command, value) {
  if (!savedSelection) return;
  const { editor, range } = savedSelection;
  editor.focus();
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand(command, false, value);
  storeEditorSelection();
  captureEditors();
}
function applyFontSize(size) {
  if (!savedSelection) return;
  const { editor, range } = savedSelection;
  editor.focus();
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  if (range.collapsed) {
    // With a collapsed caret (e.g. a fresh empty line) there is nothing to wrap,
    // so the size becomes a typing style: an empty span holding a zero-width
    // placeholder, with the caret parked inside it.
    let container = range.startContainer;
    if (container.nodeType !== Node.ELEMENT_NODE) container = container.parentElement;
    const current = container?.closest ? container.closest('span[data-font-size]') : null;
    if (current && !current.textContent.replace(/\u200B/g, '')) {
      // Caret sits in a fresh placeholder span (size chosen, nothing typed
      // yet) — retarget it instead of nesting another span.
      current.dataset.fontSize = size;
    } else if (current) {
      // Caret inside already-sized text: split the span at the caret so the
      // surrounding text keeps its size while what is typed next gets the
      // new size.
      const parent = current.parentNode;
      const next = current.nextSibling;
      const rightRange = range.cloneRange();
      rightRange.selectNodeContents(current);
      rightRange.setStart(range.startContainer, range.startOffset);
      const rightContent = rightRange.extractContents();
      const keepLeft = !!current.textContent.replace(/\u200B/g, '') || !!current.querySelector('br');
      const keepRight = !!rightContent.textContent.replace(/\u200B/g, '') || !!rightContent.querySelector('br');
      const fragment = document.createDocumentFragment();
      if (keepLeft) fragment.append(current);
      const span = document.createElement('span');
      span.dataset.fontSize = size;
      span.append(document.createTextNode('\u200B'));
      fragment.append(span);
      if (keepRight) {
        const right = document.createElement('span');
        right.dataset.fontSize = current.dataset.fontSize;
        right.append(rightContent);
        fragment.append(right);
      }
      parent.insertBefore(fragment, next);
      if (!keepLeft) current.remove();
      range.setStart(span.firstChild, 1);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      const span = document.createElement('span');
      span.dataset.fontSize = size;
      span.append(document.createTextNode('\u200B'));
      range.insertNode(span);
      range.setStart(span.firstChild, 1);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  } else {
    const span = document.createElement('span');
    span.dataset.fontSize = size;
    span.append(range.extractContents());
    // The newly chosen size wins: unwrap any size spans caught inside the
    // selection. Partially selected spans are cloned into the fragment by
    // extractContents, and the leftovers outside keep their own size.
    span.querySelectorAll('span[data-font-size]').forEach((nested) => {
      const parent = nested.parentNode;
      while (nested.firstChild) parent.insertBefore(nested.firstChild, nested);
      nested.remove();
    });
    range.insertNode(span);
    range.selectNodeContents(span);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  storeEditorSelection();
  captureEditors();
}
// Reflect the font size at the caret in the toolbar instead of blindly
// activating the last-clicked button.
function updateFontSizeControls() {
  const selection = window.getSelection();
  let element = selection.anchorNode;
  if (element && element.nodeType !== Node.ELEMENT_NODE) element = element.parentElement;
  const editor = element ? (sideEditor.contains(element) ? sideEditor : bottomEditor.contains(element) ? bottomEditor : null) : null;
  const sized = editor && element.closest ? element.closest('span[data-font-size]') : null;
  const size = editor ? (sized && editor.contains(sized) ? sized.dataset.fontSize : '3') : null;
  document.querySelectorAll('.font-size-button').forEach((control) => {
    control.classList.toggle('is-active', control.dataset.fontSize === size);
  });
}
function runFormatButton(button) {
  if (button.dataset.command) { applyFormat(button.dataset.command, null); return; }
  if (button.dataset.fontSize) {
    applyFontSize(button.dataset.fontSize);
    updateFontSizeControls();
  }
}
document.querySelectorAll('.format-button[data-command], .format-button.font-size-button').forEach((button) => {
  button.addEventListener('pointerdown', (event) => { event.preventDefault(); storeEditorSelection(); });
  button.addEventListener('click', () => runFormatButton(button));
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    storeEditorSelection();
    runFormatButton(button);
  });
});
document.addEventListener('selectionchange', () => { storeEditorSelection(); updateFontSizeControls(); });
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
$('#divider-select').addEventListener('change', (event) => {
  const target = Number(event.target.value);
  if (target && target !== state.activePage) void navigateTo(target);
});
$('#export-pdf-button').addEventListener('click', exportPdf);
$('#export-button').addEventListener('click', exportMarkdown);
$('#save-button').addEventListener('click', saveNote);
$('#back-button').addEventListener('click', () => { if (confirm('العودة للبداية تُغلق المذكرة الحالية غير المحفوظة. هل تريد المتابعة؟')) showHome(); });
document.querySelectorAll('.theme-toggle').forEach((button) => button.addEventListener('click', () => { state.theme = state.theme === 'light' ? 'dark' : 'light'; applyTheme(); }));
applyTheme();
window.addEventListener('beforeunload', (event) => { if (workspaceView.hidden === false) { event.preventDefault(); event.returnValue = ''; } });

let pendingSwReload = false;
function flushPendingSwReload() {
  if (!pendingSwReload || workspaceView.hidden === false) return;
  pendingSwReload = false;
  window.location.reload();
}

if ('serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    if (workspaceView.hidden === false) { pendingSwReload = true; return; }
    reloading = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => console.error('Service Worker registration failed:', error));
  });
}
