import { useEffect, useRef, useCallback, useState } from 'react'
import Matter from 'matter-js'

const { Engine, World, Bodies, Body, Composite, Sleeping, Events } = Matter

export const JAR_W = 220
export const JAR_H = 280

// Physics body matches the visual closely — narrow wire-like shape with
// chamfered corners to approximate the rounded wire profile
const CW  = 14    // physics width  (visual SVG is 12)
const CH  = 30    // physics height (visual SVG is 28)
const PAD = 4     // extra click-target padding around the button

const WALL           = 50
const DRAG_THRESHOLD = 8

// Physics bounds match the jar's inner (padding) box: 1.5px CSS border each side,
// 26px outer bottom corner radius in App.css
const INNER_W  = JAR_W - 3
const CORNER_R = 24.5

const STEP           = 1000 / 60  // fixed physics step (ms); velocity constants are tuned per step
const MAX_STEPS      = 4          // catch-up limit per frame before dropping backlog
const MAX_BODY_SPEED = 12         // px/step, settled clips
const INTRO_SPEED    = 20         // px/step, clips still in their initial free fall
const MAX_SPIN       = 0.25       // rad/step
const AIR            = 0.10       // damping once a clip has landed
const INTRO_AIR      = 0.01       // near-free fall before first contact

function landClip(b) {
  b.introFall   = false
  b.frictionAir = AIR
}

// Per-step limits: velocity cap (clamps collision impulses, e.g. from body
// removal, not just jostle kicks) and the free-fall landing fallback
function limitBody(b) {
  if (b.introFall && ++b.introAge > 20 && b.speed < 1) landClip(b)
  const cap   = b.introFall ? INTRO_SPEED : MAX_BODY_SPEED
  const speed = Math.hypot(b.velocity.x, b.velocity.y)
  if (speed > cap) {
    Body.setVelocity(b, { x: (b.velocity.x / speed) * cap, y: (b.velocity.y / speed) * cap })
  }
  if (Math.abs(b.angularVelocity) > MAX_SPIN) {
    Body.setAngularVelocity(b, Math.sign(b.angularVelocity) * MAX_SPIN)
  }
}

function makeClipBody(clip, dropPos, intro) {
  const body = Bodies.rectangle(
    dropPos ? dropPos.x : 15 + Math.random() * (INNER_W - 30),
    dropPos ? dropPos.y : -(CH / 2 + 4 + Math.random() * 40),
    CW, CH,
    {
      friction:       0.6,
      frictionAir:    intro ? INTRO_AIR : AIR,
      restitution:    0.08,
      density:        0.007,
      angle:          (Math.random() - 0.5) * Math.PI,
      sleepThreshold: 30,
      chamfer:        { radius: 6 },
    }
  )
  body.clipId    = clip.id
  body.introFall = intro
  body.introAge  = 0
  Body.setVelocity(body, {
    x: (Math.random() - 0.5) * (intro ? 1 : 2),
    y: intro ? 1.5 : dropPos ? 0.5 : 0,
  })
  return body
}

// Run the pour to rest synchronously (≈100ms of CPU for 50 clips) so a view
// that opens later shows a settled pile instead of replaying the drop
function presettle(engine, bodies) {
  const queue = bodies.slice()
  for (let step = 0; step < 420; step++) {
    if (queue.length && step % 2 === 0) Composite.add(engine.world, queue.shift())
    Engine.update(engine, STEP)
    for (const b of Composite.allBodies(engine.world)) {
      if (b.clipId !== undefined && !b.isStatic) limitBody(b)
    }
    if (!queue.length && bodies.every(b => b.isSleeping)) break
  }
}

// ─── PhysicsJar ──────────────────────────────────────────────────────────────
export function PhysicsJar({
  clips, onMove, label, sublabel, isDone, hint, emptyLabel,
  onDragStart,       // (clipId, color, pointerEvent) → called when drag begins
  draggingClipId,    // id of clip being dragged FROM this jar (hide its button)
  dropPosRef,        // ref: { [clipId]: {x,y} } — spawn at cursor on drop
  isGhostDragging,   // true while any ghost drag is in flight (suppress jostle)
  onLabelChange,     // (newLabel: string) → called when user renames the jar
  height = JAR_H,    // jar height in px; fixed for the component's lifetime (remount to change)
  presettled = false, // bulk loads appear already at rest (no pour animation)
}) {
  const innerH = height - 3
  const engineRef    = useRef(null)
  const heightRef    = useRef(height)
  const bodiesRef    = useRef({})   // clipId → Matter.Body
  const clipRefs     = useRef({})   // clipId → <button> DOM node
  const rafRef       = useRef(null)
  const isRunningRef = useRef(false)
  const tickRef      = useRef(0)
  const lastTimeRef  = useRef(performance.now())
  const accRef       = useRef(0)
  const timeoutsRef  = useRef(new Map())  // clipId → pending spawn timeout
  const frozenRef    = useRef(null) // clipId frozen during an active drag

  // ── Label editing ────────────────────────────────────────────────────────
  const [editingLabel, setEditingLabel] = useState(false)
  const [labelDraft, setLabelDraft] = useState(label)
  const labelInputRef = useRef(null)

  useEffect(() => {
    if (!editingLabel) setLabelDraft(label)
  }, [label, editingLabel])

  useEffect(() => {
    if (editingLabel && labelInputRef.current) {
      labelInputRef.current.focus()
      labelInputRef.current.select()
    }
  }, [editingLabel])

  // ── Loop: only runs while bodies are moving; stops when all sleeping ────
  const startLoop = useCallback(() => {
    if (isRunningRef.current) return
    isRunningRef.current = true
    lastTimeRef.current  = performance.now()
    accRef.current       = STEP  // step on the very first frame

    const tick = () => {
      const engine = engineRef.current
      if (!isRunningRef.current || !engine) return

      // Fixed-timestep accumulator: simulated time tracks wall time even when
      // frames are slow, instead of slow frames turning into slow motion.
      const now = performance.now()
      accRef.current += Math.min(now - lastTimeRef.current, 250)
      lastTimeRef.current = now
      const frame = ++tickRef.current

      const dynamic = Composite.allBodies(engine.world)
        .filter(b => b.clipId !== undefined && !b.isStatic)

      let steps = 0
      while (accRef.current >= STEP && steps < MAX_STEPS) {
        Engine.update(engine, STEP)
        accRef.current -= STEP
        steps++

        for (const b of dynamic) limitBody(b)
      }
      if (steps === MAX_STEPS) accRef.current = 0

      // ── Position / rotation (every frame, direct DOM write) ──────────
      for (const b of dynamic) {
        const el = clipRefs.current[b.clipId]
        if (!el) continue
        el.style.transform =
          `translate(${b.position.x - CW/2 - PAD}px,${b.position.y - CH/2 - PAD}px) rotate(${b.angle}rad)`
      }

      // ── Depth lighting (every 8 frames) ─────────────────────────────
      // Blurred CSS drop-shadows on every moving clip halved the frame rate, so
      // the shadow is a static SVG layer offset via CSS vars, and styles are
      // only rewritten when a clip's quantized depth or rotation changes.
      if (frame % 8 === 0) {
        dynamic
          .slice()
          .sort((a, b) => b.position.y - a.position.y)
          .forEach((b, i) => {
            const el = clipRefs.current[b.clipId]
            if (!el) return
            if (b.zIndex !== i) { el.style.zIndex = i; b.zIndex = i }
            const d   = Math.round(Math.max(0, Math.min(1, b.position.y / heightRef.current)) * 20) / 20
            const rot = Math.round(b.angle * 8) / 8
            const key = `${d}|${rot}`
            if (b.lightKey === key) return
            b.lightKey = key
            const off = 1 + d * 3.5  // screen-space drop, rotated into the clip's local frame
            el.style.setProperty('--d', d)  // depth shading curve lives in App.css per theme
            el.style.setProperty('--sx', `${(off * Math.sin(rot)).toFixed(2)}px`)
            el.style.setProperty('--sy', `${(off * Math.cos(rot)).toFixed(2)}px`)
            el.style.setProperty('--sa', (0.22 + d * 0.33).toFixed(2))
          })
      }

      // ── Stop loop once every dynamic body is sleeping ────────────────
      if (dynamic.length === 0 || dynamic.every(b => b.isSleeping)) {
        isRunningRef.current = false
        rafRef.current = null
        return
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
  }, [])

  // ── Engine init ──────────────────────────────────────────────────────────
  useEffect(() => {
    const engine = Engine.create({
      gravity:            { x: 0, y: 2.5 },
      enableSleeping:     true,
      positionIterations: 10,
      velocityIterations: 10,
    })
    engineRef.current = engine

    // A free-falling clip "lands" on first contact with the jar bottom or with a
    // clip already resting in the pile; from then on it gets normal damping.
    // Side-wall grazes and mid-air contacts with other falling clips don't count.
    const restsOn = o => o.isFloor || (o.clipId !== undefined && !o.introFall && o.speed < 2)
    Events.on(engine, 'collisionStart', ({ pairs }) => {
      for (const { bodyA: a, bodyB: b } of pairs) {
        if (a.introFall && restsOn(b)) landClip(a)
        if (b.introFall && restsOn(a)) landClip(b)
      }
    })

    const floor = Bodies.rectangle(INNER_W/2, innerH + WALL/2, INNER_W + WALL*2, WALL, { isStatic: true, friction: 0.7, restitution: 0.05 })
    // 45° chamfers approximating the rounded bottom corners
    const corner = (arcCx, dir) => {
      const px = arcCx - dir * CORNER_R * Math.SQRT1_2
      const py = innerH - CORNER_R + CORNER_R * Math.SQRT1_2
      const S  = 60
      return Bodies.rectangle(px - dir * Math.SQRT1_2 * S/2, py + Math.SQRT1_2 * S/2, S, S,
        { isStatic: true, friction: 0.7, angle: Math.PI / 4 })
    }
    const cornerL = corner(CORNER_R, 1)
    const cornerR = corner(INNER_W - CORNER_R, -1)
    floor.isFloor = cornerL.isFloor = cornerR.isFloor = true

    Composite.add(engine.world, [
      floor, cornerL, cornerR,
      Bodies.rectangle(-WALL/2,         innerH/2, WALL, innerH*4, { isStatic: true, friction: 0.7 }),
      Bodies.rectangle(INNER_W + WALL/2, innerH/2, WALL, innerH*4, { isStatic: true, friction: 0.7 }),
    ])

    startLoop()

    return () => {
      isRunningRef.current = false
      cancelAnimationFrame(rafRef.current)
      timeoutsRef.current.forEach(clearTimeout)
      timeoutsRef.current.clear()
      World.clear(engine.world)
      Engine.clear(engine)
      engineRef.current = null
    }
  }, [startLoop])

  // ── Sync clips array → physics world ────────────────────────────────────
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return

    const currentIds = new Set(clips.map(c => c.id))

    // Remove bodies whose clips left this jar
    for (const [idStr, body] of Object.entries(bodiesRef.current)) {
      if (!currentIds.has(Number(idStr))) {
        Composite.remove(engine.world, body)
        delete bodiesRef.current[idStr]
      }
    }

    // Cancel pending spawns only for clips that left; a re-render mid-pour must
    // not restart the pour for the clips still waiting.
    const pending = timeoutsRef.current
    for (const [id, t] of pending) {
      if (!currentIds.has(id)) { clearTimeout(t); pending.delete(id) }
    }

    const newClips = clips.filter(c => !bodiesRef.current[c.id] && !pending.has(c.id))

    // Bulk loads (app launch, reset, new set) are poured in: each clip is
    // released from just above the jar over a short window and free-falls
    // until it lands, rather than drifting down at air-damped terminal speed.
    const isBulkLoad = newClips.length > 3
    const pourMs     = Math.min(700, newClips.length * 9)

    if (isBulkLoad && presettled) {
      const bodies = newClips.map(clip => makeClipBody(clip, null, true))
      bodies.forEach(b => { bodiesRef.current[b.clipId] = b })
      presettle(engine, bodies)
      startLoop()
      return
    }

    newClips.forEach((clip, i) => {
      const delay = isBulkLoad ? (i / newClips.length) * pourMs + Math.random() * 30 : 0
      const t = setTimeout(() => {
        pending.delete(clip.id)
        if (!engineRef.current || bodiesRef.current[clip.id]) return

        // Consume the stored drop position (cursor coords in jar-local space)
        const dropPos = dropPosRef?.current?.[clip.id]
        if (dropPos) delete dropPosRef.current[clip.id]
        const body = makeClipBody(clip, dropPos, isBulkLoad && !dropPos)
        bodiesRef.current[clip.id] = body
        Composite.add(engine.world, body)
        startLoop()
      }, delay)

      pending.set(clip.id, t)
    })
  }, [clips, startLoop, dropPosRef, presettled])

  // ── Unfreeze body when drag ends (draggingClipId → null) ───────────────
  useEffect(() => {
    if (draggingClipId !== null && draggingClipId !== undefined) return
    const frozen = frozenRef.current
    if (frozen === null) return

    frozenRef.current = null
    const body = bodiesRef.current[frozen]
    if (body?.isStatic) {
      // If a same-jar drop position was recorded, teleport body there first
      const dropPos = dropPosRef?.current?.[frozen]
      if (dropPos) {
        delete dropPosRef.current[frozen]
        Body.setPosition(body, dropPos)
      }
      Body.setStatic(body, false)
      Sleeping.set(body, false)   // wake the body so the loop doesn't immediately exit
      Body.setVelocity(body, { x: 0, y: dropPos ? 0.5 : -0.5 })
      startLoop()
    }
  }, [draggingClipId, startLoop, dropPosRef])

  // ── Cursor sweep: push clips only while a button is held ────────────────
  const handleJarPointerMove = useCallback((e) => {
    if (isGhostDragging) return   // ghost drag in flight — don't jostle
    if (e.buttons === 0) return   // hover-only movement — no jostle

    const engine = engineRef.current
    if (!engine) return

    const rect = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    const RADIUS    = 44  // px — push field radius
    const MAX_KICK  = 3   // px/tick added per event
    const MAX_SPEED = 6   // hard cap so clips can't fly off

    const all     = Composite.allBodies(engine.world)
    const dynamic = all.filter(b => b.clipId !== undefined && !b.isStatic)

    let any = false
    for (const b of dynamic) {
      const dx   = b.position.x - mx
      const dy   = b.position.y - my
      const dist = Math.hypot(dx, dy)
      if (dist < RADIUS && dist > 0.5) {
        const scale = (RADIUS - dist) / RADIUS
        if (b.isSleeping) Sleeping.set(b, false)

        // Accumulate velocity kick in repulsion direction …
        let vx = b.velocity.x + (dx / dist) * scale * MAX_KICK
        let vy = b.velocity.y + (dy / dist) * scale * MAX_KICK

        // … but clamp total speed so rapid mouse movement can't rocket clips
        const speed = Math.hypot(vx, vy)
        if (speed > MAX_SPEED) {
          vx = (vx / speed) * MAX_SPEED
          vy = (vy / speed) * MAX_SPEED
        }

        Body.setVelocity(b, { x: vx, y: vy })
        any = true
      }
    }
    if (any) startLoop()
  }, [isGhostDragging, startLoop])

  // ── Drag / click handling ────────────────────────────────────────────────
  const handlePointerDown = useCallback((e, clip) => {
    e.preventDefault()
    const ox = e.clientX
    const oy = e.clientY
    let   dragging = false

    const onPMove = (e) => {
      if (dragging) return
      if (Math.hypot(e.clientX - ox, e.clientY - oy) >= DRAG_THRESHOLD) {
        dragging = true
        const body = bodiesRef.current[clip.id]
        if (body) Body.setStatic(body, true)
        frozenRef.current = clip.id
        onDragStart?.(clip.id, clip.color, e)
      }
    }

    const onPUp = () => {
      document.removeEventListener('pointermove', onPMove)
      document.removeEventListener('pointerup',   onPUp)
      if (!dragging) onMove(clip.id)
    }

    document.addEventListener('pointermove', onPMove)
    document.addEventListener('pointerup',   onPUp)
  }, [onMove, onDragStart])

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="jar-wrap">
      <div className="jar-label">
        {editingLabel ? (
          <input
            ref={labelInputRef}
            className="jar-label-input"
            value={labelDraft}
            onChange={e => setLabelDraft(e.target.value)}
            onBlur={() => {
              setEditingLabel(false)
              const trimmed = labelDraft.trim()
              if (trimmed) onLabelChange?.(trimmed)
              else setLabelDraft(label)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') e.target.blur()
              if (e.key === 'Escape') { e.preventDefault(); setLabelDraft(label); setEditingLabel(false) }
            }}
          />
        ) : (
          <span
            title="Double-click to rename"
            className="jar-label-text"
            onDoubleClick={() => { setLabelDraft(label); setEditingLabel(true) }}
          >
            {label}
          </span>
        )}
      </div>

      <div
        className={`jar jar-${isDone ? 'done' : 'todo'}`}
        data-jar={isDone ? 'right' : 'left'}
        style={{ width: JAR_W, height, position: 'relative', overflow: 'hidden', flexShrink: 0 }}
        onPointerMove={handleJarPointerMove}
      >
        <div className="jar-sheen" />
        {clips.length === 0 && <div className="jar-empty">{emptyLabel}</div>}

        {clips.map(clip => {
          const hidden = clip.id === draggingClipId
          return (
            <button
              key={clip.id}
              ref={el => { if (el) clipRefs.current[clip.id] = el; else delete clipRefs.current[clip.id] }}
              className="clip-btn clip-physics"
              style={{
                position:      'absolute',
                left: 0, top: 0,
                width:         CW + PAD * 2,
                height:        CH + PAD * 2,
                transform:     'translate(-9999px, 0)',
                '--col':       clip.color,
                opacity:       hidden ? 0 : 1,
                pointerEvents: hidden ? 'none' : 'auto',
              }}
              onPointerDown={e => handlePointerDown(e, clip)}
            >
              <ClipSVG color={clip.color} shadow />
            </button>
          )
        })}
      </div>

      <div className="jar-sublabel">{sublabel}</div>
    </div>
  )
}

// ─── Shared paper-clip SVG ────────────────────────────────────────────────────
const OUTER_PATH = 'M 10,3 C 10,0 2,0 2,3 L 2,24 C 2,27 10,27 10,24 Z'
const INNER_PATH = 'M 7.5,4 L 7.5,19 C 7.5,22 4,22 4,19'

export function ClipSVG({ color, scale = 1, shadow = false }) {
  const w = Math.round(12 * scale)
  const h = Math.round(28 * scale)
  return (
    <svg viewBox="0 0 12 28" width={w} height={h} overflow="visible" aria-hidden>
      {shadow && (
        <g className="clip-shadow" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path className="halo" d={OUTER_PATH} strokeWidth="4.6" />
          <path className="halo" d={INNER_PATH} strokeWidth="4.6" />
          <path d={OUTER_PATH} strokeWidth="2.4" />
          <path d={INNER_PATH} strokeWidth="2.4" />
        </g>
      )}
      <path d="M 10,3 C 10,0 2,0 2,3 L 2,24 C 2,27 10,27 10,24 Z"
        stroke={color} strokeWidth="1.8" fill="none"
        strokeLinecap="round" strokeLinejoin="round" />
      <path d="M 7.5,4 L 7.5,19 C 7.5,22 4,22 4,19"
        stroke={color} strokeWidth="1.8" fill="none"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
