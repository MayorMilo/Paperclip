const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, screen, ipcMain } = require('electron')
const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')

const isDev = !app.isPackaged

const WIN_W   = 520
const WIN_H   = 520
const PANEL_W = 520
// Normal window height, but never more than half the screen
const panelHeight = wa => Math.min(WIN_H, Math.floor(wa.height / 2))
const BG      = { dark: '#140c02', light: '#FAF6EC' }

let mainWin = null
let panel   = null
let tray    = null
let panelOpen   = false
let panelAnim   = null
let panelClosedAt = 0

// ── Preferences the main process needs before a page loads ─────────────────
const prefsPath = () => path.join(app.getPath('userData'), 'prefs.json')
function readPrefs() {
  try { return JSON.parse(fs.readFileSync(prefsPath(), 'utf8')) } catch { return {} }
}
let prefs = {}
function savePrefs(patch) {
  prefs = { ...prefs, ...patch }
  try { fs.writeFileSync(prefsPath(), JSON.stringify(prefs)) } catch {}
}
// Before the user picks a theme the renderer follows the system appearance; match it
const bgColor = () => BG[prefs.theme] || (nativeTheme.shouldUseDarkColors ? BG.dark : BG.light)

// Restore the last position only if it's still mostly on a connected display
function savedPosition() {
  const p = prefs.mainPos
  if (!p) return {}
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    p.x + WIN_W - 60 > a.x && p.x + 60 < a.x + a.width && p.y >= a.y - 10 && p.y + 40 < a.y + a.height)
  return visible ? { x: p.x, y: p.y } : {}
}

function loadPage(win, query) {
  if (isDev) win.loadURL(`http://localhost:5173${query ? `?${new URLSearchParams(query)}` : ''}`)
  else win.loadFile(path.join(__dirname, '../dist/index.html'), { query })
}

const webPreferences = {
  preload: path.join(__dirname, 'preload.js'),
  nodeIntegration: false,
  contextIsolation: true,
}

// ── Main window ─────────────────────────────────────────────────────────────
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    ...savedPosition(),
    alwaysOnTop: !!prefs.keepOnTop,
    resizable: false,
    fullscreenable: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: bgColor(),
    show: false,
    webPreferences,
  })
  loadPage(mainWin)
  mainWin.once('ready-to-show', () => { mainWin.show(); mainWin.focus() })
  mainWin.on('will-move', () => mainWin.webContents.send('window:will-move'))
  mainWin.on('moved', () => {
    const { x, y } = mainWin.getBounds()
    savePrefs({ mainPos: { x, y } })
  })
  mainWin.on('closed', () => { mainWin = null })
}

function showMainWindow() {
  if (panelOpen) hidePanel()
  if (!mainWin) return createMainWindow()
  if (mainWin.isMinimized()) mainWin.restore()
  mainWin.show()
  app.focus({ steal: true })
  mainWin.focus()
}

// ── Side panel: the app sliding in from the right edge of the screen ───────
function createPanel() {
  const wa = screen.getPrimaryDisplay().workArea
  panel = new BrowserWindow({
    width: PANEL_W,
    height: panelHeight(wa),
    x: wa.x + wa.width,
    y: wa.y,
    type: 'panel',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    show: false,
    backgroundColor: bgColor(),
    webPreferences,
  })
  panel.setAlwaysOnTop(true, 'pop-up-menu')
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  loadPage(panel, { panel: '1' })
  panel.on('blur', () => { if (panelOpen) hidePanel() })
  panel.on('closed', () => { panel = null; panelOpen = false })
}

function animateX(win, fromX, toX, ms, ease, { fade = null, done } = {}) {
  clearInterval(panelAnim)
  const { y, width, height } = win.getBounds()
  const t0 = Date.now()
  panelAnim = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(panelAnim)
    const t = Math.min(1, (Date.now() - t0) / ms)
    win.setBounds({ x: Math.round(fromX + (toX - fromX) * ease(t)), y, width, height })
    if (fade) win.setOpacity(fade === 'in' ? ease(t) : 1 - ease(t))
    if (t === 1) { clearInterval(panelAnim); done?.() }
  }, 8)
}

// With a display to the right, a full off-screen slide would pass across it;
// use a short slide with a fade instead.
function hasDisplayToRight(display) {
  const { x, y, width, height } = display.bounds
  return screen.getAllDisplays().some(d => d.id !== display.id &&
    d.bounds.x >= x + width - 1 && d.bounds.y < y + height && d.bounds.y + d.bounds.height > y)
}
const easeOut = t => 1 - Math.pow(1 - t, 3)
const easeIn  = t => t * t * t

function showPanel() {
  if (!panel) createPanel()
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const wa = display.workArea
  const shortSlide = hasDisplayToRight(display)
  const openX = wa.x + wa.width - PANEL_W
  const fromX = shortSlide ? openX + 48 : wa.x + wa.width
  panel.setBounds({ x: fromX, y: wa.y, width: PANEL_W, height: panelHeight(wa) })
  panel.setOpacity(shortSlide ? 0 : 1)
  panelOpen = true
  const reveal = () => {
    panel.webContents.send('panel:will-show')
    panel.show()
    panel.focus()
    animateX(panel, fromX, openX, 240, easeOut, { fade: shortSlide ? 'in' : null })
  }
  if (panel.webContents.isLoading()) panel.webContents.once('did-finish-load', reveal)
  else reveal()
}

function hidePanel() {
  if (!panel || !panelOpen) return
  panelOpen = false
  panelClosedAt = Date.now()
  const { x } = panel.getBounds()
  const display = screen.getDisplayMatching(panel.getBounds())
  const shortSlide = hasDisplayToRight(display)
  const toX = shortSlide ? x + 48 : display.workArea.x + display.workArea.width
  animateX(panel, x, toX, 180, easeIn, {
    fade: shortSlide ? 'out' : null,
    done: () => { if (!panelOpen) panel.hide() },
  })
}

// ── Where is the user? Frontmost app + whether it has visible windows ──────
// Uses AppKit/CoreGraphics through JXA; needs no Automation or Screen Recording permission.
const FRONT_SCRIPT = `
ObjC.import('AppKit'); ObjC.import('CoreGraphics');
(() => {
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication
  const pid = front.processIdentifier
  const info = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))
  let windows = 0
  for (let i = 0; i < info.count; i++) {
    const w = info.objectAtIndex(i)
    if (w.objectForKey('kCGWindowOwnerPID').js !== pid || w.objectForKey('kCGWindowLayer').js !== 0) continue
    const b = w.objectForKey('kCGWindowBounds')
    if (b.objectForKey('Width').js >= 80 && b.objectForKey('Height').js >= 80) windows++
  }
  return JSON.stringify({ pid, bundle: front.bundleIdentifier.js, windows })
})()`

function frontContext() {
  return new Promise(resolve => {
    execFile('osascript', ['-l', 'JavaScript', '-e', FRONT_SCRIPT], { timeout: 1500 }, (err, out) => {
      try { resolve(err ? null : JSON.parse(out)) } catch { resolve(null) }
    })
  })
}

// Pre-computed when the pointer reaches the menu-bar icon, so a click doesn't wait on it
let pendingContext = null
let pendingAt = 0
function prefetchContext() {
  pendingContext = frontContext()
  pendingAt = Date.now()
}

async function onTrayClick() {
  // A click on the icon first blurs an open panel (which starts closing it);
  // treat that click as "close", not "reopen".
  if (panelOpen) return hidePanel()
  if (Date.now() - panelClosedAt < 350) return

  // Not open (closed, hidden or minimised) → open the app
  if (!mainWin || !mainWin.isVisible() || mainWin.isMinimized()) return showMainWindow()

  const ctx = await (pendingContext && Date.now() - pendingAt < 2000 ? pendingContext : frontContext())
  pendingContext = null
  const ours      = ctx?.pid === process.pid
  const onDesktop = ctx?.bundle === 'com.apple.finder' && ctx.windows === 0
  // A pinned window is already on screen over other apps; a panel would duplicate it
  const pinned    = mainWin.isAlwaysOnTop()
  if (!ctx || ours || onDesktop || pinned) showMainWindow()
  else showPanel()
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('PaperClips')
  tray.on('mouse-enter', prefetchContext)
  tray.on('click', onTrayClick)
  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: 'Open PaperClips', click: showMainWindow },
      { label: 'Show Side Panel', click: showPanel },
      { type: 'separator' },
      { label: 'Quit PaperClips', role: 'quit' },
    ]))
  })
}

// ── IPC from the renderer ───────────────────────────────────────────────────
ipcMain.on('panel:close', () => hidePanel())
ipcMain.on('theme:set', (_e, theme) => {
  if (!BG[theme] || prefs.theme === theme) return
  savePrefs({ theme })
  for (const w of [mainWin, panel]) if (w && !w.isDestroyed()) w.setBackgroundColor(BG[theme])
})
ipcMain.on('window:keep-on-top', (_e, on) => {
  if (prefs.keepOnTop !== on) savePrefs({ keepOnTop: on })
  mainWin?.setAlwaysOnTop(on)
})

function buildAppMenu() {
  // No Reload / DevTools / Zoom: they break the fixed-size layout or replay the pour
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
        { type: 'separator' },
        { label: 'Show Side Panel', click: showPanel },
        ...(isDev ? [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] : []),
      ],
    },
  ]))
}

app.whenReady().then(() => {
  prefs = readPrefs()
  buildAppMenu()
  createTray()
  createMainWindow()
  // Load the side panel in the background so the first open is instant
  setTimeout(() => { if (!panel) createPanel() }, 1500)
})

// Automation hook for end-to-end tests (menu-bar clicks can't be scripted without extra OS permissions)
if (process.env.PAPERCLIPS_TEST) {
  global.paperclipsTest = {
    trayClick: onTrayClick,
    frontContext,
    state: () => ({
      main: mainWin && { visible: mainWin.isVisible(), focused: mainWin.isFocused(), minimized: mainWin.isMinimized(), bounds: mainWin.getBounds(), movable: mainWin.isMovable() },
      panel: panel && { visible: panel.isVisible(), focused: panel.isFocused(), bounds: panel.getBounds() },
      panelOpen,
      tray: tray?.getBounds(),
      onTop: mainWin?.isAlwaysOnTop(),
      prefs,
    }),
  }
}

// Closing the window keeps PaperClips in the menu bar
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => showMainWindow())
