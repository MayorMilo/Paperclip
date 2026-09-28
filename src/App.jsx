import { useState, useEffect, useCallback, useMemo, useRef, forwardRef } from 'react'
import { PhysicsJar, ClipSVG, JAR_W, JAR_H } from './PhysicsJar.jsx'
import { usePersistentState } from './usePersistentState.js'

const PALETTE = [
  '#FF6B6B', '#FF8E53', '#FFD700', '#6BCB77', '#4DAAFF',
  '#C77DFF', '#FF6BD6', '#48DBFB', '#A29BFE', '#FD79A8',
  '#00C896', '#E17055', '#74B9FF', '#55EFC4', '#FDCB6E',
]

const STORAGE_KEY = 'paperclips-v1'
const TITLES_KEY  = 'paperclips-titles-v1'
const GOAL_KEY    = 'paperclips-goal-v1'
export const THEME_KEY = 'paperclips-theme-v1'
export const ONTOP_KEY = 'paperclips-ontop-v1'
const IS_PANEL = new URLSearchParams(location.search).has('panel')
// Everything in the layout except the jars themselves (header, title, labels, counters, button)
const PANEL_CHROME = 236

export const systemTheme = () => (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')

function todayStr() {
  return new Date().toLocaleDateString('en-CA')
}

function calcStreak(history) {
  let streak = 0
  const d = new Date()
  const todayKey = d.toLocaleDateString('en-CA')

  if (history[todayKey] > 0) {
    streak++
    d.setDate(d.getDate() - 1)
    while (true) {
      const k = d.toLocaleDateString('en-CA')
      if (history[k] > 0) { streak++; d.setDate(d.getDate() - 1) }
      else break
    }
  } else {
    d.setDate(d.getDate() - 1)
    while (true) {
      const k = d.toLocaleDateString('en-CA')
      if (history[k] > 0) { streak++; d.setDate(d.getDate() - 1) }
      else break
    }
  }
  return streak
}

function makeClips(count, clipColor, useRandom) {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    jar: 'left',
    color: useRandom ? PALETTE[i % PALETTE.length] : clipColor,
    rotation: Math.round(-28 + Math.random() * 56),
  }))
}

const DEFAULT_COLOR = '#5B9CF6'

export default function App() {
  const [state, setState] = usePersistentState(STORAGE_KEY, () => ({
    clips: makeClips(50, DEFAULT_COLOR, false),
    settings: { clipColor: DEFAULT_COLOR, useRandom: false, totalClips: 50 },
    history: {},
  }))

  const [showSettings, setShowSettings] = useState(false)
  const settingsRef = useRef(null)
  const appRef = useRef(null)

  useEffect(() => {
    if (showSettings) settingsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [showSettings])

  useEffect(() => window.paperclips?.onPanelShow(() => {
    setShowSettings(false)
    document.activeElement?.blur()
    appRef.current?.scrollTo(0, 0)
  }), [])
  const [flash, setFlash] = useState(null)

  const [jarTitles, setJarTitles] = usePersistentState(TITLES_KEY, { left: 'To Send', right: 'Done' })
  const [goal, setGoal] = usePersistentState(GOAL_KEY, '', { raw: true })
  const [themeChoice, setThemeChoice] = usePersistentState(THEME_KEY, '', { raw: true })
  const [osTheme, setOsTheme] = useState(systemTheme)
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: light)')
    const onChange = () => setOsTheme(mq.matches ? 'light' : 'dark')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  const theme = themeChoice === 'light' || themeChoice === 'dark' ? themeChoice : osTheme
  const [keepOnTop, setKeepOnTop] = usePersistentState(ONTOP_KEY, false)

  useEffect(() => {
    if (!IS_PANEL) window.paperclips?.setKeepOnTop(keepOnTop)
  }, [keepOnTop])

  // Dragging the window happens outside the page, so finish any text edit here
  useEffect(() => window.paperclips?.onWindowMove(() => document.activeElement?.blur()), [])

  // The side panel can be shorter than the main window (≤ half the screen); jars shrink to fit
  const [viewH, setViewH] = useState(window.innerHeight)
  useEffect(() => {
    if (!IS_PANEL) return
    const onResize = () => setViewH(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const jarH = IS_PANEL ? Math.max(180, Math.min(JAR_H, viewH - PANEL_CHROME)) : JAR_H

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.paperclips?.setTheme(theme)
  }, [theme])

  // Side panel: Escape slides it away
  useEffect(() => {
    if (!IS_PANEL) return
    const onKey = e => { if (e.key === 'Escape' && !e.defaultPrevented) window.paperclips?.closePanel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── Drag state ───────────────────────────────────────────────────────────
  // dragRef holds stable info that doesn't need re-renders; ghostPos does
  const dragRef    = useRef(null)   // { clipId, fromJar, color }
  const [ghostPos, setGhostPos] = useState(null)  // { x, y } or null
  const dropPosRef = useRef({})     // clipId → {x, y} in target-jar-local coords

  const handleDragStart = useCallback((clipId, fromJar, color, e) => {
    dragRef.current = { clipId, fromJar, color }
    setGhostPos({ x: e.clientX, y: e.clientY })
  }, [])

  const { clips, settings, history } = state
  const today = todayStr()
  const streak = useMemo(() => calcStreak(history), [history])
  const leftClips = clips.filter(c => c.jar === 'left')
  const rightClips = clips.filter(c => c.jar === 'right')

  // moveClip defined before the drag effect that depends on it
  const moveClip = useCallback((id, fromJar) => {
    setState(prev => {
      const toJar = fromJar === 'left' ? 'right' : 'left'
      const newHistory = { ...prev.history }
      if (!newHistory[today]) newHistory[today] = 0
      if (fromJar === 'left') newHistory[today]++
      else newHistory[today] = Math.max(0, newHistory[today] - 1)
      return {
        ...prev,
        clips: prev.clips.map(c => c.id === id ? { ...c, jar: toJar } : c),
        history: newHistory,
      }
    })
  }, [today])

  useEffect(() => {
    if (leftClips.length === 0 && clips.length > 0) {
      setFlash('complete')
      const t = setTimeout(() => setFlash(null), 3500)
      return () => clearTimeout(t)
    }
  }, [leftClips.length, clips.length])

  // Global pointer listeners — active only while a drag is in flight
  useEffect(() => {
    if (!ghostPos) return

    const onMove = (e) => setGhostPos({ x: e.clientX, y: e.clientY })

    const onUp = (e) => {
      const drag = dragRef.current
      if (drag) {
        const els   = document.elementsFromPoint(e.clientX, e.clientY)
        const jarEl = els.find(el => el.dataset.jar)
        const toJar = jarEl?.dataset.jar
        if (toJar && toJar !== drag.fromJar) {
          // Record cursor position relative to the target jar so the clip
          // spawns where it was dropped rather than falling from the top
          if (jarEl) {
            const rect = jarEl.getBoundingClientRect()
            dropPosRef.current[drag.clipId] = {
              x: Math.max(10, Math.min(JAR_W - 10, e.clientX - rect.left)),
              y: Math.max(16, Math.min(rect.height - 16, e.clientY - rect.top)),
            }
          }
          moveClip(drag.clipId, drag.fromJar)
        } else if (toJar === drag.fromJar && jarEl) {
          // Same-jar drop: record cursor position so clip falls from where it was released
          const rect = jarEl.getBoundingClientRect()
          dropPosRef.current[drag.clipId] = {
            x: Math.max(10, Math.min(JAR_W - 10, e.clientX - rect.left)),
            y: Math.max(16, Math.min(rect.height - 16, e.clientY - rect.top)),
          }
        }
      }
      dragRef.current = null
      setGhostPos(null)
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup',   onUp)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup',   onUp)
    }
  }, [ghostPos !== null, moveClip])

  const applySettings = useCallback((newSettings) => {
    setState(prev => ({
      ...prev,
      clips: prev.clips.map((c, i) => ({
        ...c,
        color: newSettings.useRandom ? PALETTE[i % PALETTE.length] : newSettings.clipColor,
      })),
      settings: newSettings,
    }))
  }, [])

  const resetToday = useCallback(() => {
    setState(prev => ({
      ...prev,
      clips: prev.clips.map(c => ({ ...c, jar: 'left' })),
      history: { ...prev.history, [today]: 0 },
    }))
    setShowSettings(false)
  }, [today])

  const newSet = useCallback((count) => {
    setState(prev => ({
      clips: makeClips(count, prev.settings.clipColor, prev.settings.useRandom),
      settings: { ...prev.settings, totalClips: count },
      history: prev.history,
    }))
    setShowSettings(false)
  }, [])

  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  })

  return (
    <div ref={appRef} className={`app${IS_PANEL ? ' app-panel' : ''}`}>
      <div className="header">
        <div className="date">{dateLabel}</div>
        <div className="header-right">
          {streak > 0 && (
            <div className="streak-badge">
              <FlameIcon />
              <span className="streak-num">{streak}</span>
              <span className="streak-txt">day streak</span>
            </div>
          )}
          <button
            className="icon-btn"
            onClick={() => setThemeChoice(theme === 'light' ? 'dark' : 'light')}
            title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          >
            {theme === 'light' ? <MoonIcon /> : <SunIcon />}
          </button>
          {IS_PANEL && (
            <button
              className="icon-btn"
              onClick={() => window.paperclips?.closePanel()}
              title="Close panel (Esc)"
              aria-label="Close panel"
            >
              <CloseIcon />
            </button>
          )}
        </div>
      </div>

      <input
        className="goal-title"
        value={goal}
        placeholder="New Goal"
        aria-label="Goal title"
        maxLength={60}
        spellCheck={false}
        onChange={e => setGoal(e.target.value)}
        onBlur={() => setGoal(g => g.trim())}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur() } }}
      />

      {flash === 'complete' && (
        <div className="banner">All {clips.length} outreaches done. Incredible.</div>
      )}

      <div className="jars-row">
        <PhysicsJar
          label={jarTitles.left}
          onLabelChange={name => setJarTitles(t => ({ ...t, left: name }))}
          sublabel={clipCount(leftClips.length)}
          key={`left-${jarH}`}
          height={jarH}
          presettled={IS_PANEL}
          clips={leftClips}
          emptyLabel="All sent!"
          onMove={id => moveClip(id, 'left')}
          hint="Click or drag to the Done jar"
          isDone={false}
          onDragStart={(id, color, e) => handleDragStart(id, 'left', color, e)}
          draggingClipId={dragRef.current?.fromJar === 'left' ? dragRef.current?.clipId : null}
          dropPosRef={dropPosRef}
          isGhostDragging={ghostPos !== null}
        />
        <ArrowIcon />
        <PhysicsJar
          label={jarTitles.right}
          onLabelChange={name => setJarTitles(t => ({ ...t, right: name }))}
          sublabel={clipCount(rightClips.length)}
          key={`right-${jarH}`}
          height={jarH}
          presettled={IS_PANEL}
          clips={rightClips}
          emptyLabel="None yet..."
          onMove={id => moveClip(id, 'right')}
          hint="Click or drag back to undo"
          isDone={true}
          onDragStart={(id, color, e) => handleDragStart(id, 'right', color, e)}
          draggingClipId={dragRef.current?.fromJar === 'right' ? dragRef.current?.clipId : null}
          dropPosRef={dropPosRef}
          isGhostDragging={ghostPos !== null}
        />
      </div>

      {/* Ghost clip that follows cursor during drag */}
      {ghostPos && dragRef.current && (
        <div
          className="clip-ghost"
          style={{ left: ghostPos.x, top: ghostPos.y }}
        >
          <ClipSVG color={dragRef.current.color} scale={1.4} />
        </div>
      )}

      <div className="counters">
        <div className="counter">
          <span className="counter-n">{leftClips.length}</span>
          <span className="counter-label">remaining</span>
        </div>
        <div className="counter-sep" />
        <div className="counter">
          <span className="counter-n">{rightClips.length}</span>
          <span className="counter-label">sent today</span>
        </div>
      </div>

      <button className="settings-btn" onClick={() => setShowSettings(s => !s)}>
        {showSettings ? 'Close' : 'Settings'}
      </button>

      {showSettings && (
        <SettingsPanel
          ref={settingsRef}
          keepOnTop={keepOnTop}
          onKeepOnTop={IS_PANEL ? null : setKeepOnTop}
          settings={settings}
          onApply={applySettings}
          onReset={resetToday}
          onNewSet={newSet}
        />
      )}
    </div>
  )
}


const clipCount = n => `${n} ${n === 1 ? 'clip' : 'clips'}`

function FlameIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="#FF8C42" aria-hidden>
      <path d="M12 2c0 5.5-7 9-7 14a7 7 0 0014 0c0-5-7-8.5-7-14z" />
      <path d="M12 8c0 3-3.5 5-3.5 8a3.5 3.5 0 007 0c0-3-3.5-5-3.5-8z" fill="#FFD700" opacity=".8" />
    </svg>
  )
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <div className="jar-arrow">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
        stroke="var(--arrow)" strokeWidth="2" strokeLinecap="round">
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    </div>
  )
}

const SettingsPanel = forwardRef(function SettingsPanel({ settings, onApply, onReset, onNewSet, keepOnTop, onKeepOnTop }, ref) {
  const [color, setColor] = useState(settings.clipColor)
  const [useRandom, setUseRandom] = useState(settings.useRandom)
  const [count, setCount] = useState(settings.totalClips)

  return (
    <div className="settings" ref={ref}>
      <div className="settings-title">Settings</div>

      {onKeepOnTop && (
        <div className="setting-row">
          <label className="setting-label">Keep window on top</label>
          <button
            className={`toggle ${keepOnTop ? 'on' : ''}`}
            onClick={() => onKeepOnTop(!keepOnTop)}
            aria-pressed={keepOnTop}
            aria-label="Keep window on top"
          >
            <span className="toggle-thumb" />
          </button>
        </div>
      )}

      <div className="setting-row">
        <label className="setting-label">Random colors</label>
        <button
          className={`toggle ${useRandom ? 'on' : ''}`}
          onClick={() => setUseRandom(v => !v)}
        >
          <span className="toggle-thumb" />
        </button>
      </div>

      {!useRandom && (
        <>
          <div className="setting-row">
            <label className="setting-label">Clip color</label>
            <input type="color" value={color} onChange={e => setColor(e.target.value)} className="color-input" />
          </div>
          <div className="presets">
            {PALETTE.map(c => (
              <button
                key={c}
                className="preset"
                style={{ background: c, boxShadow: color === c ? `0 0 0 2px white, 0 0 0 3px ${c}` : 'none' }}
                onClick={() => setColor(c)}
                title={c}
              />
            ))}
          </div>
        </>
      )}

      <div className="setting-row">
        <label className="setting-label">Clips per set</label>
        <input
          type="number" value={count} min={1} max={365}
          onChange={e => setCount(Math.max(1, Math.min(365, parseInt(e.target.value) || 50)))}
          className="num-input"
        />
      </div>

      <div className="settings-actions">
        <button className="btn-primary" onClick={() => onApply({ clipColor: color, useRandom, totalClips: count })}>
          Apply colors
        </button>
        <button className="btn-secondary" onClick={resetToday}>
          Reset today
        </button>
        <button className="btn-danger" onClick={() => onNewSet(count)}>
          New set ({count})
        </button>
      </div>
    </div>
  )

  function resetToday() {
    if (window.confirm('Move all clips back to "To Send"?')) onReset()
  }
})
