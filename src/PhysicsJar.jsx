import { useEffect, useRef, useCallback } from 'react'
import Matter from 'matter-js'

const { Engine, World, Bodies, Body, Composite, Sleeping } = Matter

export const JAR_W = 220
export const JAR_H = 280

// Physics body only slightly larger than the visual (12×28) — gives minimal
// forced spacing while still preventing full overlap
const CW  = 16    // physics width  (visual SVG is 12)
const CH  = 32    // physics height (visual SVG is 28)
const PAD = 4     // extra click-target padding around the button

const WALL           = 50
const DRAG_THRESHOLD = 8

// ─── PhysicsJar ──────────────────────────────────────────────────────────────
export function PhysicsJar({
  clips, onMove, label, sublabel, isDone, hint, emptyLabel,
  onDragStart,       // (clipId, color, pointerEvent) → called when drag begins
  draggingClipId,    // id of clip being dragged FROM this jar (hide its button)
  dropPosRef,        // ref: { [clipId]: {x,y} } — spawn at cursor on drop
  isGhostDragging,   // true while any ghost drag is in flight (suppress jostle)
}) {
  const engineRef    = useRef(null)
  const bodiesRef    = useRef({})   // clipId → Matter.Body
  const clipRefs     = useRef({})   // clipId → <button> DOM node
  const rafRef       = useRef(null)
  const isRunningRef = useRef(false)
  const tickRef      = useRef(0)
  const lastTimeRef  = useRef(performance.now())
  const timeoutsRef  = useRef([])
  const frozenRef    = useRef(null) // clipId frozen during an active drag

  // ── Loop: only runs while bodies are moving; stops when all sleeping ────
  const startLoop = useCallback(() => {
    if (isRunningRef.current) return
    isRunningRef.current = true
    lastTimeRef.current  = performance.now()

    const tick = () => {
      if (!isRunningRef.current || !engineRef.current) return

      const now = performance.now()
      Engine.update(engineRef.current, Math.min(now - lastTimeRef.current, 16.67))
      lastTimeRef.current = now
      const frame = ++tickRef.current

      const all       = Composite.allBodies(engineRef.current.world)
      const dynamic   = all.filter(b => b.clipId !== undefined && !b.isStatic)

      // ── Position / rotation (every frame, direct DOM write) ──────────
      for (const b of dynamic) {
        const el = clipRefs.current[b.clipId]
        if (!el) continue
        el.style.transform =
          `translate(${b.position.x - CW/2 - PAD}px,${b.position.y - CH/2 - PAD}px) rotate(${b.angle}rad)`
      }

      // ── Depth lighting (every 8 frames) ─────────────────────────────
      if (frame % 8 === 0) {
        dynamic
          .slice()
          .sort((a, b) => b.position.y - a.position.y)
          .forEach((b, i) => {
            const el = clipRefs.current[b.clipId]
            if (!el) return
            el.style.zIndex = i
            const d = Math.max(0, Math.min(1, b.position.y / JAR_H))
            el.style.filter = [
              `brightness(${(1.12 - d * 0.42).toFixed(2)})`,
              `drop-shadow(0 ${(1 + d * 5).toFixed(1)}px ${(2 + d * 10).toFixed(1)}px rgba(0,0,0,${(0.18 + d * 0.52).toFixed(2)}))`,
            ].join(' ')
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
      gravity:        { x: 0, y: 4 },
      enableSleeping: true,
    })
    engineRef.current = engine

    Composite.add(engine.world, [
      Bodies.rectangle(JAR_W/2,      JAR_H + WALL/2, JAR_W + WALL*2, WALL,  { isStatic: true, friction: 0.7, restitution: 0.05 }),
      Bodies.rectangle(-WALL/2,      JAR_H/2,        WALL, JAR_H*4,          { isStatic: true, friction: 0.7 }),
      Bodies.rectangle(JAR_W+WALL/2, JAR_H/2,        WALL, JAR_H*4,          { isStatic: true, friction: 0.7 }),
    ])

    startLoop()

    return () => {
      isRunningRef.current = false
      cancelAnimationFrame(rafRef.current)
      timeoutsRef.current.forEach(clearTimeout)
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

    const newClips   = clips.filter(c => !bodiesRef.current[c.id])
    const isBulkLoad = newClips.length > 3

    timeoutsRef.current.forEach(clearTimeout)
    timeoutsRef.current = []

    newClips.forEach((clip, i) => {
      // Read drop position at schedule time so we can set delay=0 for drops
      const hasDrop = !!(dropPosRef?.current?.[clip.id])
      const delay   = hasDrop ? 0 : (isBulkLoad ? i * 18 : 0)

      const t = setTimeout(() => {
        if (!engineRef.current || bodiesRef.current[clip.id]) return

        // Consume the stored drop position (cursor coords in jar-local space)
        const dropPos = dropPosRef?.current?.[clip.id]
        if (dropPos) delete dropPosRef.current[clip.id]

        const body = Bodies.rectangle(
          dropPos ? dropPos.x : 15 + Math.random() * (JAR_W - 30),
          dropPos ? dropPos.y : -(CH / 2 + Math.random() * 40),
          CW, CH,
          {
            friction:       0.55,
            frictionAir:    0.045,
            restitution:    0.1,
            density:        0.006,
            angle:          (Math.random() - 0.5) * Math.PI,
            sleepThreshold: 20,
          }
        )
        body.clipId = clip.id
        Body.setVelocity(body, {
          x: (Math.random() - 0.5) * 2,
          y: dropPos ? 0.5 : 0,
        })
        bodiesRef.current[clip.id] = body
        Composite.add(engine.world, body)
        startLoop()
      }, delay)

      timeoutsRef.current.push(t)
    })
  }, [clips, startLoop, dropPosRef])

  // ── Unfreeze body when drag is cancelled (draggingClipId → null) ────────
  useEffect(() => {
    if (draggingClipId !== null && draggingClipId !== undefined) return
    const frozen = frozenRef.current
    if (!frozen) return

    frozenRef.current = null
    const body = bodiesRef.current[frozen]
    if (body?.isStatic) {
      Body.setStatic(body, false)
      Body.setVelocity(body, { x: 0, y: -0.5 })
      startLoop()
    }
  }, [draggingClipId, startLoop])

  // ── Cursor sweep: push clips only while a button is held ────────────────
  const handleJarPointerMove = useCallback((e) => {
    if (isGhostDragging) return   // ghost drag in flight — don't jostle
    if (e.buttons === 0) return   // hover-only movement — no jostle

    const engine = engineRef.current
    if (!engine) return

    const rect = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    const RADIUS    = 32  // px — push field radius
    const MAX_KICK  = 2   // px/tick added per event
    const MAX_SPEED = 5   // hard cap so clips can't fly off

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
      <div className="jar-label">{label}</div>

      <div
        className={`jar jar-${isDone ? 'done' : 'todo'}`}
        data-jar={isDone ? 'right' : 'left'}
        style={{ width: JAR_W, height: JAR_H, position: 'relative', overflow: 'hidden', flexShrink: 0 }}
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
              <ClipSVG color={clip.color} />
            </button>
          )
        })}
      </div>

      <div className="jar-sublabel">{sublabel}</div>
    </div>
  )
}

// ─── Shared paper-clip SVG ────────────────────────────────────────────────────
export function ClipSVG({ color, scale = 1 }) {
  const w = Math.round(12 * scale)
  const h = Math.round(28 * scale)
  return (
    <svg viewBox="0 0 12 28" width={w} height={h} aria-hidden>
      <path d="M 10,3 C 10,0 2,0 2,3 L 2,24 C 2,27 10,27 10,24 Z"
        stroke={color} strokeWidth="1.8" fill="none"
        strokeLinecap="round" strokeLinejoin="round" />
      <path d="M 7.5,4 L 7.5,19 C 7.5,22 4,22 4,19"
        stroke={color} strokeWidth="1.8" fill="none"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
