const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
const state = { pdfBytes: null, pdfDocument: null, pageCount: 0, pages: [], marginScale: 1, activePage: 1, meta: null };

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

function defaultPages(count) { return Array.from({ length: count }, (_, index) => ({ pageNumber: index + 1, sideMargin: '', bottomMargin: '' })); }
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
        if (['2', '3', '4'].includes(size)) span.dataset.fontSize = size;
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
  if (![1, 2, 3].includes(data.marginScale) || !data.pdf?.data || !Number.isInteger(data.pdf?.pageCount) || !Array.isArray(data.pages)) throw new Error('بيانات ملف المذكرة غير مكتملة أو معطوبة.');
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
    state.pages = data.pages.map((page) => ({ ...page, sideMargin: cleanHtml(page.sideMargin), bottomMargin: cleanHtml(page.bottomMargin) }));
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
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json;charset=utf-8' })); link.download = `${baseName(state.meta.originalFileName || state.meta.title)}.hamsh`; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000); showToast('تم حفظ المذكرة وتنزيلها.');
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
$('#save-button').addEventListener('click', saveNote);
$('#back-button').addEventListener('click', () => { if (confirm('العودة للبداية تُغلق المذكرة الحالية غير المحفوظة. هل تريد المتابعة؟')) showHome(); });
window.addEventListener('beforeunload', (event) => { if (workspaceView.hidden === false) { event.preventDefault(); event.returnValue = ''; } });
