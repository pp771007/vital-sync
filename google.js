const CLIENT_ID = '959499500594-srq9p0eqltr58f7th3mpd59h5bb1qvee.apps.googleusercontent.com';
// drive.file：只碰得到這個網站建立的檔案；Sheets API 也吃這個權限，Drive API 靠它搜尋自己建的試算表
const DATA_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const TIMEZONE = 'Asia/Taipei';
const SHEET_LOCALE = 'zh_TW';

const SPREADSHEET_TITLE = 'VITAL-SYNC';
// 只認這個標記、不認檔名：使用者可能改名，而測試或其他本網站建的檔案也會出現在搜尋結果裡
const APP_MARKER = { key: 'vitalSync', value: 'main' };

// 欄位順序跟 GAS 版一樣，舊資料才能直接貼過來
const SHEETS = {
  bp: { title: '血壓紀錄', headers: ['ID', '時間', '收縮壓', '舒張壓', '心跳', '備註'] },
  weight: { title: '體重紀錄', headers: ['ID', '時間', '體重', '備註'] },
};

// 由高到低排，每一級的上限就是上一級的門檻。試算表的上色規則因此互不重疊：
// Google 不照送出的順序決定哪條規則優先，重疊的話低等級的顏色會蓋掉高等級
const BP_LEVELS = [
  { name: '二期', color: '#a855f7', sys: 160, dia: 100 },
  { name: '一期', color: '#ef4444', sys: 140, dia: 90 },
  { name: '前期', color: '#f59e0b', sys: 120, dia: 80 },
];
const PULSE_FAST = { color: '#ef4444', above: 100 };
const ALERT_TEXT_COLOR = '#ffffff';

const TOKEN_ERROR_MESSAGES = {
  popup_closed: '授權視窗被關掉了，請再按一次',
  popup_failed_to_open: '授權視窗被瀏覽器擋下，請允許這個網站開彈出視窗後再按一次',
};
const DEFAULT_TOKEN_ERROR = '授權沒有完成，請再按一次';

// 存在瀏覽器：顯示用的帳號資料、最長一小時就失效的 access token、上次找到的試算表，重新整理才不必再登入一次
const SESSION_KEY = 'vital-sync:session';
// 剩不到一分鐘的權杖，拿來用可能在請求途中就過期，當作已過期
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;
// 還沒送進試算表的紀錄。每筆都先存這裡再上傳，網路斷掉或授權過期時資料不會不見
const OUTBOX_KEY = 'vital-sync:outbox';
// 兩個分頁同時上傳會把同一筆寫兩次（網路恢復時兩邊會同時收到 online 事件）
const OUTBOX_LOCK = 'vital-sync:outbox';
// 網路不穩時請求可能卡好幾分鐘都不失敗；逾時就當作沒送到，資料留在手機上等下一輪
const GOOGLE_FETCH_TIMEOUT_MS = 15 * 1000;
const GIS_SRC = 'https://accounts.google.com/gsi/client';

const $ = (id) => document.getElementById(id);
// spreadsheetVerified：這次開網頁後確認過試算表還在、而且不在垃圾桶。從瀏覽器記住的那份不算數，
// 因為 Google 照樣接受寫進垃圾桶裡的試算表，不確認的話資料會寫進使用者已經丟掉的檔案
const state = { user: null, token: null, tokenExpiresAt: 0, spreadsheet: null, spreadsheetStatus: 'idle', spreadsheetVerified: false };
let tokenClient = null;
let tokenRequest = null;
let pendingToken = null;
let pendingSpreadsheet = null;
let pendingFlush = null;
let gisLoading = false;
// 使用者自己關掉授權視窗 = 現在不想等（多半是網路慢）。這段期間按儲存就不再自動跳視窗，
// 紀錄留在手機上，要上傳時點「待上傳」；離開 App 再回來就恢復自動（見 visibilitychange）
let tokenPromptDismissed = false;

// 不寫成 HTML 裡的 <script>：離線打開時那個載入失敗就不會再試，網路恢復後也拿不到新的授權
function loadGis() {
  if (window.google?.accounts || gisLoading) return;
  gisLoading = true;
  const script = document.createElement('script');
  script.src = GIS_SRC;
  script.async = true;
  script.onload = () => { gisLoading = false; onGisLoaded(); };
  script.onerror = () => { gisLoading = false; script.remove(); onGisFailed(); };
  document.head.appendChild(script);
}

function onGisLoaded() {
  google.accounts.id.initialize({ client_id: CLIENT_ID, callback: onCredential });
  google.accounts.id.renderButton($('signin-button'), {
    theme: 'filled_black',
    size: 'large',
    shape: 'pill',
    locale: 'zh-TW',
  });
  if (state.user) initTokenClient();
  clearError();
  render();
}

// localStorage 在瀏覽器封鎖網站資料時會直接丟例外；存不了就退回每次都要登入，不影響其他功能
function saveSession() {
  try {
    const spreadsheet = state.spreadsheet && { ...state.spreadsheet, created: false };
    localStorage.setItem(SESSION_KEY, JSON.stringify({ user: state.user, token: state.token, tokenExpiresAt: state.tokenExpiresAt, spreadsheet }));
  } catch {}
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

function restoreSession() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch {}
  if (!saved?.user) return;
  setUser(saved.user);
  state.spreadsheet = saved.spreadsheet ?? null;
  state.spreadsheetStatus = state.spreadsheet ? 'ready' : 'idle';
  state.token = saved.token ?? null;
  state.tokenExpiresAt = saved.tokenExpiresAt ?? 0;
  if (tokenStatus() !== 'granted') return;
  // 權杖還有效就先在背景確認、順便補送上次沒送出的；過期的話等第一次按按鈕時再確認（見 prepare）
  ensureSpreadsheet().then(flushOutbox).catch(() => {});
}

function tokenUsableUntil() {
  return state.tokenExpiresAt - TOKEN_EXPIRY_MARGIN_MS;
}


function onGisFailed() {
  showError('Google 登入元件載入失敗，請檢查網路後重新整理');
}

// ID token 只拿來顯示是誰登入；能不能讀寫試算表由 Google 驗 access token 決定，所以這裡不驗簽章
function decodeJwtPayload(jwt) {
  const base64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// 不等 Google 登入元件：登入過的人離線打開也要直接進到輸入畫面，授權用的元件載到了再補（見 onGisLoaded）
function setUser(user) {
  state.user = user;
  tokenClient = null;
  if (window.google?.accounts) initTokenClient();
  notifyOutboxChange();
}

function initTokenClient() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: DATA_SCOPE,
    login_hint: state.user.email,
    callback: onTokenResponse,
    error_callback: (err) => {
      const dismissed = err.type === 'popup_closed';
      if (dismissed) tokenPromptDismissed = true;
      tokenRequest?.reject(Object.assign(authError(TOKEN_ERROR_MESSAGES[err.type] || DEFAULT_TOKEN_ERROR), { isDismissed: dismissed }));
    },
  });
}

// 按儲存後要不要自動上傳：權杖有效就直接送；過期的話要跳授權視窗，使用者剛關掉過就不跳
function autoUploadAllowed() {
  return tokenStatus() === 'granted' || !tokenPromptDismissed;
}

// isAuth：這類錯誤要把原因直接告訴使用者（例如彈窗被擋），其他錯誤只說「失敗，請重試」
function authError(message) {
  return Object.assign(new Error(message), { isAuth: true });
}

// isOffline：沒送到 Google。存在手機上的紀錄照樣留著，下一輪再送
function offlineError() {
  return Object.assign(new Error('連不上 Google，請確認網路'), { isOffline: true });
}

function onCredential({ credential }) {
  const { email, name, picture } = decodeJwtPayload(credential);
  setUser({ email, name, picture });
  saveSession();
  clearError();
  render();
}

// 瀏覽器只准「使用者剛點擊的當下」開彈窗，所以這支一定要在按鈕的點擊處理裡、第一個 await 之前被呼叫
function ensureToken() {
  if (tokenStatus() === 'granted') return Promise.resolve();
  if (!tokenClient) return Promise.reject(offlineError());
  if (!pendingToken) {
    pendingToken = new Promise((resolve, reject) => {
      tokenRequest = { resolve, reject };
      // prompt 空字串：同意過就不再跳同意畫面，彈窗會自己關掉
      tokenClient.requestAccessToken({ prompt: '' });
    }).finally(() => {
      pendingToken = null;
      tokenRequest = null;
    });
  }
  return pendingToken;
}

function onTokenResponse(response) {
  if (response.error) return tokenRequest?.reject(authError(DEFAULT_TOKEN_ERROR));
  // 使用者可以在同意畫面把試算表那格取消勾選，這時拿到的 token 沒有試算表權限
  if (!google.accounts.oauth2.hasGrantedAllScopes(response, DATA_SCOPE)) {
    return tokenRequest?.reject(authError('試算表權限沒有勾選，請再按一次並勾選它'));
  }
  state.token = response.access_token;
  state.tokenExpiresAt = Date.now() + Number(response.expires_in) * 1000;
  saveSession();
  render();
  tokenRequest?.resolve();
}

function authorize() {
  clearError();
  ensureToken().then(ensureSpreadsheet).then(flushOutbox).catch((err) => showError(err.message));
}

// 所有讀寫試算表的動作都先經過這裡；跟 ensureToken 一樣要在點擊當下、第一個 await 之前呼叫
async function prepare() {
  await ensureToken();
  if (!state.spreadsheetVerified) await ensureSpreadsheet();
}

async function googleFetch(url, options = {}) {
  let response;
  let body;
  // 逾時也可能發生在讀回應內容的途中，所以讀完內容才算收到
  try {
    response = await fetch(url, {
      ...options,
      headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    });
    if (response.status !== 401) body = await response.json();
  } catch {
    throw offlineError();
  }
  if (response.status === 401) {
    state.token = null;
    saveSession();
    render();
    throw authError('授權已失效，請再按一次');
  }
  if (!response.ok) {
    throw new Error('Google 連線失敗（' + response.status + '）：' + (body.error?.message || '未知錯誤'));
  }
  return body;
}


const SPREADSHEET_FIELDS = 'spreadsheetId,spreadsheetUrl,sheets.properties(sheetId,title)';

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { red: (n >> 16) / 255, green: ((n >> 8) & 0xff) / 255, blue: (n & 0xff) / 255 };
}

// test 收到第一筆資料的儲存格（例如 C2），回傳比較式；規則會套到整欄
function colorRule(sheetId, header, headers, test, color) {
  const column = headers.indexOf(header);
  const cell = String.fromCharCode('A'.charCodeAt(0) + column) + '2';
  return {
    ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: column, endColumnIndex: column + 1 }],
    booleanRule: {
      // ISNUMBER：試算表把文字當成比任何數字都大，不擋的話格子裡打字也會被上色
      condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=AND(ISNUMBER(${cell}), ${test(cell)})` }] },
      format: {
        backgroundColorStyle: { rgbColor: hexToRgb(color) },
        textFormat: { foregroundColorStyle: { rgbColor: hexToRgb(ALERT_TEXT_COLOR) } },
      },
    },
  };
}

function bpLevelRules(sheetId, header, key) {
  return BP_LEVELS.map((level, i) => {
    const upper = BP_LEVELS[i - 1]?.[key];
    const test = (c) => (upper === undefined ? `${c}>=${level[key]}` : `${c}>=${level[key]}, ${c}<${upper}`);
    return colorRule(sheetId, header, SHEETS.bp.headers, test, level.color);
  });
}

function bpColorRules(sheetId) {
  return [
    ...bpLevelRules(sheetId, '收縮壓', 'sys'),
    ...bpLevelRules(sheetId, '舒張壓', 'dia'),
    colorRule(sheetId, '心跳', SHEETS.bp.headers, (c) => `${c}>${PULSE_FAST.above}`, PULSE_FAST.color),
  ];
}

async function findSpreadsheet() {
  const query = new URLSearchParams({
    q: `appProperties has { key='${APP_MARKER.key}' and value='${APP_MARKER.value}' } and trashed=false`,
    fields: 'files(id)',
    // 兩台裝置同時第一次登入可能各建一份，固定用最早那份
    orderBy: 'createdTime',
    pageSize: '1',
  });
  const { files } = await googleFetch(`${DRIVE_FILES_API}?${query}`);
  if (files.length === 0) return null;
  return googleFetch(`${SHEETS_API}/${files[0].id}?fields=${SPREADSHEET_FIELDS}`);
}

async function createSpreadsheet() {
  const sheets = Object.entries(SHEETS).map(([key, def], index) => {
    const sheetId = index + 1;
    return {
      properties: { sheetId, title: def.title, gridProperties: { frozenRowCount: 1 } },
      data: [{
        startRow: 0,
        startColumn: 0,
        rowData: [{
          values: def.headers.map((h) => ({
            userEnteredValue: { stringValue: h },
            userEnteredFormat: { textFormat: { bold: true } },
          })),
        }],
      }],
      conditionalFormats: key === 'bp' ? bpColorRules(sheetId) : [],
    };
  });
  const created = await googleFetch(`${SHEETS_API}?fields=${SPREADSHEET_FIELDS}`, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title: SPREADSHEET_TITLE, locale: SHEET_LOCALE, timeZone: TIMEZONE },
      sheets,
    }),
  });
  // 標記失敗的話下次會再建一份，而不是拿到一份沒設定好的，所以先建檔再加標記
  await googleFetch(`${DRIVE_FILES_API}/${created.spreadsheetId}`, {
    method: 'PATCH',
    body: JSON.stringify({ appProperties: { [APP_MARKER.key]: APP_MARKER.value } }),
  });
  return created;
}

function toSpreadsheetState(meta, created) {
  const idsByTitle = Object.fromEntries(meta.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
  const sheetIds = {};
  for (const [key, def] of Object.entries(SHEETS)) {
    if (!(def.title in idsByTitle)) {
      throw new Error(`試算表裡找不到「${def.title}」分頁，把它改回這個名字後按「重試」`);
    }
    sheetIds[key] = idsByTitle[def.title];
  }
  return { id: meta.spreadsheetId, url: meta.spreadsheetUrl, sheetIds, created };
}

// 同時跑兩次會各自找不到、各建一份，所以同一時間只跑一次，其他呼叫者等同一個結果
function ensureSpreadsheet() {
  if (!pendingSpreadsheet) {
    pendingSpreadsheet = loadSpreadsheet().finally(() => { pendingSpreadsheet = null; });
  }
  return pendingSpreadsheet;
}

async function loadSpreadsheet() {
  const user = state.user;
  state.spreadsheetStatus = 'loading';
  clearError();
  render();
  try {
    const found = await findSpreadsheet();
    const spreadsheet = found ? toSpreadsheetState(found, false) : toSpreadsheetState(await createSpreadsheet(), true);
    if (state.user !== user) throw new Error('帳號已切換');
    state.spreadsheet = spreadsheet;
    state.spreadsheetVerified = true;
    state.spreadsheetStatus = 'ready';
    saveSession();
    render();
  } catch (err) {
    if (state.user === user) {
      state.spreadsheetStatus = state.spreadsheet ? 'ready' : 'error';
      showError(err.message);
      render();
    }
    throw err;
  }
}

function sheetRange(key, cells) {
  return encodeURIComponent(`'${SHEETS[key].title}'!${cells}`);
}

// 試算表的日期數值以 1899-12-30 為第 0 天；1970-01-01 是第 25569 天
const SERIAL_UNIX_EPOCH = 25569;
const MS_PER_DAY = 86400000;
const TIMESTAMP_FORMAT = { type: 'DATE_TIME', pattern: 'yyyy/mm/dd hh:mm:ss' };

// 日期數值是試算表時區（台灣）的牆上時間，不是 UTC
function toSerialDateTime(date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(date).map((part) => [part.type, Number(part.value)])
  );
  const wallClockMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallClockMs / MS_PER_DAY + SERIAL_UNIX_EPOCH;
}

function toNumberOrBlank(value) {
  const n = Number.parseFloat(value);
  return Number.isNaN(n) ? '' : n;
}

function toIntOrBlank(value) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? '' : n;
}

// stringValue 一律當純文字存，= 開頭的備註不會被當成公式執行
function toCell(value) {
  if (value === '' || value === undefined) return {};
  return { userEnteredValue: typeof value === 'number' ? { numberValue: value } : { stringValue: value } };
}

function notifyOutboxChange() {
  window.dispatchEvent(new Event('outboxchange'));
}

// localStorage 被封鎖時退回記憶體：重新整理就沒了，但這次開著的期間還能補送
let memoryOutbox = [];

function loadOutbox() {
  try {
    const saved = localStorage.getItem(OUTBOX_KEY);
    if (saved !== null) return JSON.parse(saved);
  } catch {}
  return memoryOutbox;
}

function saveOutbox(records) {
  memoryOutbox = records;
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(records)); } catch {}
  notifyOutboxChange();
}

// 只看目前登入的帳號：換帳號登入時，前一個帳號沒送出的紀錄不能寫進這個帳號的試算表
function pendingRecords() {
  return state.user ? loadOutbox().filter((r) => r.email === state.user.email) : [];
}

function removeFromOutbox(ids) {
  saveOutbox(loadOutbox().filter((r) => !ids.includes(r.id)));
}

// 按下儲存的當下就記下時間：之後才上傳時，試算表裡仍是量測的時間而不是上傳的時間
function queueRecord(key, data) {
  const fields = key === 'bp'
    ? { 收縮壓: toIntOrBlank(data.sys), 舒張壓: toIntOrBlank(data.dia), 心跳: toIntOrBlank(data.pulse) }
    : { 體重: toNumberOrBlank(data.weight) };
  const record = {
    id: crypto.randomUUID(),
    key,
    email: state.user.email,
    time: Date.now(),
    fields: { ...fields, 備註: data.note },
    attempted: false,
  };
  saveOutbox([...loadOutbox(), record]);
}

function toRowCells(key, record) {
  const timeCell = { userEnteredValue: { numberValue: toSerialDateTime(new Date(record.time)) }, userEnteredFormat: { numberFormat: TIMESTAMP_FORMAT } };
  return SHEETS[key].headers.map((h) => {
    if (h === 'ID') return toCell(record.id);
    if (h === '時間') return timeCell;
    return toCell(record.fields[h]);
  });
}

function idColumnRange(key) {
  const column = String.fromCharCode('A'.charCodeAt(0) + SHEETS[key].headers.indexOf('ID'));
  return `'${SHEETS[key].title}'!${column}:${column}`;
}

async function existingIds(keys) {
  const params = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE' });
  for (const key of keys) params.append('ranges', idColumnRange(key));
  const { valueRanges = [] } = await googleFetch(`${SHEETS_API}/${state.spreadsheet.id}/values:batchGet?${params}`);
  return new Set(valueRanges.flatMap((range) => (range.values ?? []).map((row) => String(row[0] ?? ''))));
}

// 授權過期時要跳授權視窗，所以跟 ensureToken 一樣要在點擊當下、第一個 await 之前呼叫；
// 沒有點擊的自動補送只在權杖還有效時才叫它（見 autoFlush）
function flushOutbox() {
  // 正在送的那一輪不含它開始之後才存的紀錄，等它結束再送一輪
  if (pendingFlush) return pendingFlush.catch(() => {}).then(flushOutbox);
  if (pendingRecords().length === 0) return Promise.resolve();
  pendingFlush = prepare()
    .then(() => (navigator.locks ? navigator.locks.request(OUTBOX_LOCK, sendPending) : sendPending()))
    .finally(() => { pendingFlush = null; });
  return pendingFlush;
}

async function sendPending() {
  let records = pendingRecords();
  // 上一輪送出後沒等到回應的，可能其實已經寫進去了；先查試算表有沒有這個 ID，免得同一筆寫兩次
  const unsure = records.filter((r) => r.attempted);
  if (unsure.length > 0) {
    const existing = await existingIds([...new Set(unsure.map((r) => r.key))]);
    const written = unsure.filter((r) => existing.has(r.id)).map((r) => r.id);
    removeFromOutbox(written);
    records = records.filter((r) => !written.includes(r.id));
  }
  if (records.length === 0) return;
  // 瀏覽器說沒網路時一定沒送出去（說有網路則不一定）。不先擋的話會被標成「可能送到了」，
  // 離線時就沒辦法直接從手機上刪掉它（見 deleteRecord）
  if (!navigator.onLine) throw offlineError();

  const ids = records.map((r) => r.id);
  saveOutbox(loadOutbox().map((r) => (ids.includes(r.id) ? { ...r, attempted: true } : r)));
  // 不用 values.append：它從指定範圍「猜」表格在哪，猜錯會寫到標題列。
  // appendCells 跟 GAS 的 appendRow 一樣，接在整個分頁最後一列有資料的下面
  const requests = Object.keys(SHEETS)
    .map((key) => ({ key, rows: records.filter((r) => r.key === key).sort((a, b) => a.time - b.time) }))
    .filter(({ rows }) => rows.length > 0)
    .map(({ key, rows }) => ({
      appendCells: {
        sheetId: state.spreadsheet.sheetIds[key],
        rows: rows.map((r) => ({ values: toRowCells(key, r) })),
        fields: 'userEnteredValue,userEnteredFormat.numberFormat',
      },
    }));
  // batchUpdate 是全有或全無：一次送完，不會停在寫了一半
  await googleFetch(`${SHEETS_API}/${state.spreadsheet.id}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
  removeFromOutbox(ids);
}

function autoFlush() {
  if (state.user && tokenStatus() === 'granted') flushOutbox().catch(() => {});
}

const HISTORY_LIMIT = 20;

// 日期數值就是試算表時區（台灣）的牆上時間，當成 UTC 取出年月日時分，才不會再被瀏覽器時區位移一次
function formatSerialDateTime(serial) {
  const ms = Math.round(((serial - SERIAL_UNIX_EPOCH) * MS_PER_DAY) / 1000) * 1000;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

async function getHistory(key) {
  await prepare();
  const { headers } = SHEETS[key];
  const lastColumn = String.fromCharCode('A'.charCodeAt(0) + headers.length - 1);
  const timeIndex = headers.indexOf('時間');
  // 讀日期數值而不是顯示文字：使用者在試算表改了時間欄的顯示格式，網站上的時間也不會跟著變
  const query = 'valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';
  const { values = [] } = await googleFetch(`${SHEETS_API}/${state.spreadsheet.id}/values/${sheetRange(key, `A2:${lastColumn}`)}?${query}`);
  const timeOf = (row) => (typeof row[timeIndex] === 'number' ? row[timeIndex] : -Infinity);
  const sheetRows = values
    .filter((row) => row.some((cell) => cell !== ''))
    .reverse()
    // 補送的紀錄接在最後一列，照列的順序排會把較早量的排到最前面
    .sort((a, b) => timeOf(b) - timeOf(a))
    .map((row) => headers.map((_, i) => {
      const cell = row[i] ?? '';
      return i === timeIndex && typeof cell === 'number' ? formatSerialDateTime(cell) : String(cell);
    }));
  const pending = pendingHistory(key);
  // 送出後沒等到回應的那筆，可能同時在試算表跟手機上
  const pendingIds = new Set(pending.map((row) => row[0]));
  return [...pending, ...sheetRows.filter((row) => !pendingIds.has(row[0]))].slice(0, HISTORY_LIMIT);
}

// 跟 getHistory 回傳同樣的格式；還沒上傳的一定比試算表裡的新，排最前面
function pendingHistory(key) {
  return pendingRecords()
    .filter((r) => r.key === key)
    .sort((a, b) => b.time - a.time)
    .map((r) => SHEETS[key].headers.map((h) => {
      if (h === 'ID') return r.id;
      if (h === '時間') return formatSerialDateTime(toSerialDateTime(new Date(r.time)));
      return String(r.fields[h] ?? '');
    }));
}

async function deleteRecord(key, id) {
  // 正在上傳的那一輪可能已經把它寫進試算表，等它結束再看它在哪裡
  if (pendingFlush) await pendingFlush.catch(() => {});
  const pending = pendingRecords().find((r) => r.id === id);
  // 從沒送出過的只在手機上，刪掉就好，不需要網路。送出過但沒等到回應的可能已經在試算表裡，兩邊都要刪
  if (pending && !pending.attempted) return removeFromOutbox([id]);
  await prepare();
  const { values = [] } = await googleFetch(
    `${SHEETS_API}/${state.spreadsheet.id}/values/${encodeURIComponent(idColumnRange(key))}?valueRenderOption=UNFORMATTED_VALUE`
  );
  if (pending) removeFromOutbox([id]);
  // values[0] 是標題列，所以陣列索引剛好等於 deleteDimension 要的列索引（從 0 起算）
  const rowIndex = values.findIndex((row, i) => i > 0 && String(row[0] ?? '') === String(id));
  // 找不到就是已經不在了（例如在試算表裡手動刪掉），跟 GAS 版一樣當作刪除完成
  if (rowIndex === -1) return;
  await googleFetch(`${SHEETS_API}/${state.spreadsheet.id}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: { sheetId: state.spreadsheet.sheetIds[key], dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 },
        },
      }],
    }),
  });
}

function spreadsheetUrl(key) {
  return `${state.spreadsheet.url}#gid=${state.spreadsheet.sheetIds[key]}`;
}

function signOut() {
  // 離線打開時登入元件可能沒載到；沒載到就沒有自動登入可以關
  window.google?.accounts.id.disableAutoSelect();
  state.user = null;
  state.token = null;
  state.tokenExpiresAt = 0;
  state.spreadsheet = null;
  state.spreadsheetStatus = 'idle';
  state.spreadsheetVerified = false;
  tokenClient = null;
  clearSession();
  clearError();
  notifyOutboxChange();
  render();
}

// 隱私權政策承諾「按登出就清除瀏覽器裡的資料」，沒上傳的健康紀錄也算在內；
// 但刪了就救不回來，所以有沒上傳的時候先讓使用者確認
async function confirmSignOut() {
  const unsent = pendingRecords();
  if (unsent.length > 0) {
    const { isConfirmed } = await Swal.fire({
      title: `還有 ${unsent.length} 筆沒上傳`,
      text: '登出會刪掉這些紀錄',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#ef4444',
      confirmButtonText: '刪除並登出',
      cancelButtonText: '取消',
      background: '#1e293b',
      color: '#fff',
    });
    if (!isConfirmed) return;
    removeFromOutbox(unsent.map((r) => r.id));
  }
  signOut();
}

function tokenStatus() {
  if (!state.token) return 'none';
  return Date.now() < tokenUsableUntil() ? 'granted' : 'expired';
}

function render() {
  const signedIn = state.user !== null;
  // 有試算表就顯示輸入畫面，不看權杖：過期的權杖會在按按鈕時才補（見 prepare）
  const ready = signedIn && state.spreadsheet !== null;
  $('auth').hidden = ready;
  $('app').hidden = !ready;
  $('account-bar').hidden = !ready;
  $('account-email').textContent = state.user?.email || '';
  $('spreadsheet-note').hidden = !(ready && state.spreadsheet.created);

  $('signin-button').hidden = signedIn;
  $('account').hidden = !signedIn;
  if (!signedIn) return;

  for (const id of ['avatar', 'account-avatar']) {
    $(id).src = state.user.picture || '';
    $(id).hidden = !state.user.picture;
  }
  $('name').textContent = state.user.name || '';
  $('email').textContent = state.user.email;

  const loading = state.spreadsheetStatus === 'loading';
  $('authorize').hidden = loading;
  $('spreadsheet-loading').hidden = !loading;
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
}

function clearError() {
  $('error').hidden = true;
}

$('authorize').addEventListener('click', authorize);
$('signout').addEventListener('click', confirmSignOut);
$('bar-signout').addEventListener('click', confirmSignOut);

// 網路斷斷續續時不一定會收到 online 事件，所以重新回到 App 時也補送一次
window.addEventListener('online', () => { loadGis(); autoFlush(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') autoFlush();
  else tokenPromptDismissed = false;
});

restoreSession();
render();
loadGis();
