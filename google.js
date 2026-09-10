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
  popup_closed: '授權視窗被關掉了，再按一次「允許存取試算表」',
  popup_failed_to_open: '授權視窗被瀏覽器擋下，請允許這個網站開彈出視窗後再試',
};
const DEFAULT_TOKEN_ERROR = '授權沒有完成，再按一次「允許存取試算表」';

const STATUS_VIEW = {
  none: { cls: 'chip-none', text: () => '未授權' },
  granted: { cls: 'chip-granted', text: () => '✓ 有效至 ' + formatTime(state.tokenExpiresAt) },
  expired: { cls: 'chip-expired', text: () => '已過期' },
};

const $ = (id) => document.getElementById(id);
const state = { user: null, token: null, tokenExpiresAt: 0, spreadsheet: null, spreadsheetStatus: 'idle' };
let tokenClient = null;
let expiryTimer = null;

function onGisLoaded() {
  google.accounts.id.initialize({ client_id: CLIENT_ID, callback: onCredential });
  google.accounts.id.renderButton($('signin-button'), {
    theme: 'filled_black',
    size: 'large',
    shape: 'pill',
    locale: 'zh-TW',
  });
  render();
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

function onCredential({ credential }) {
  const { email, name, picture } = decodeJwtPayload(credential);
  state.user = { email, name, picture };
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: DATA_SCOPE,
    login_hint: email,
    callback: onTokenResponse,
    error_callback: (err) => showError(TOKEN_ERROR_MESSAGES[err.type] || DEFAULT_TOKEN_ERROR),
  });
  clearError();
  render();
}

function requestToken() {
  // prompt 空字串：同意過就不再跳同意畫面，彈窗會自己關掉
  tokenClient.requestAccessToken({ prompt: '' });
}

function onTokenResponse(response) {
  if (response.error) return showError(DEFAULT_TOKEN_ERROR);
  // 使用者可以在同意畫面把試算表那格取消勾選，這時拿到的 token 沒有試算表權限
  if (!google.accounts.oauth2.hasGrantedAllScopes(response, DATA_SCOPE)) {
    return showError('試算表權限沒有勾選，再授權一次並勾選它');
  }
  state.token = response.access_token;
  state.tokenExpiresAt = Date.now() + Number(response.expires_in) * 1000;
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(render, state.tokenExpiresAt - Date.now());
  clearError();
  render();
  if (state.spreadsheetStatus !== 'ready') ensureSpreadsheet();
}

async function googleFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json' },
  });
  if (response.status === 401) {
    state.token = null;
    render();
    throw new Error('授權已失效，再按一次「允許存取試算表」');
  }
  const body = await response.json();
  if (!response.ok) {
    throw new Error('Google 連線失敗（' + response.status + '）：' + (body.error?.message || '未知錯誤'));
  }
  return body;
}

// 跟 GAS 版 addRecord 寫進去的格式一樣，試算表才會把它認成日期
function formatTimestamp(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
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

async function ensureSpreadsheet() {
  // 同時跑兩次會各自找不到、各建一份
  if (state.spreadsheetStatus === 'loading') return;
  const user = state.user;
  state.spreadsheetStatus = 'loading';
  clearError();
  render();
  try {
    const found = await findSpreadsheet();
    const spreadsheet = found ? toSpreadsheetState(found, false) : toSpreadsheetState(await createSpreadsheet(), true);
    if (state.user !== user) return;
    state.spreadsheet = spreadsheet;
    state.spreadsheetStatus = 'ready';
  } catch (err) {
    if (state.user !== user) return;
    state.spreadsheetStatus = 'error';
    showError(err.message);
  }
  render();
}

function signOut() {
  google.accounts.id.disableAutoSelect();
  clearTimeout(expiryTimer);
  state.user = null;
  state.token = null;
  state.tokenExpiresAt = 0;
  state.spreadsheet = null;
  state.spreadsheetStatus = 'idle';
  tokenClient = null;
  clearError();
  render();
}

function tokenStatus() {
  if (!state.token) return 'none';
  return Date.now() < state.tokenExpiresAt ? 'granted' : 'expired';
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function render() {
  const signedIn = state.user !== null;
  $('signin-button').hidden = signedIn;
  $('account').hidden = !signedIn;
  if (!signedIn) return;

  $('avatar').src = state.user.picture || '';
  $('avatar').hidden = !state.user.picture;
  $('name').textContent = state.user.name || '';
  $('email').textContent = state.user.email;

  const status = tokenStatus();
  const view = STATUS_VIEW[status];
  $('sheets-status').className = 'chip ' + view.cls;
  $('sheets-status').textContent = view.text();
  $('authorize').hidden = status === 'granted';

  const sheet = state.spreadsheetStatus;
  $('spreadsheet-row').hidden = status !== 'granted';
  $('spreadsheet-loading').hidden = sheet !== 'loading';
  $('spreadsheet-link').hidden = sheet !== 'ready';
  $('spreadsheet-retry').hidden = sheet !== 'error';
  $('spreadsheet-link').href = state.spreadsheet?.url || '';
  $('spreadsheet-note').hidden = !(sheet === 'ready' && state.spreadsheet.created);
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
}

function clearError() {
  $('error').hidden = true;
}

$('authorize').addEventListener('click', requestToken);
$('signout').addEventListener('click', signOut);
$('spreadsheet-retry').addEventListener('click', ensureSpreadsheet);
