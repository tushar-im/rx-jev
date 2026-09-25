import { useEffect, useMemo, useRef } from 'react'

export type Point = { x: number; y: number; z: number }
export type Placed = { x: number; y: number; scale: number; opacity: number; layer: number }

// One full turn a minute: slow enough to read a name as it passes.
const TURN_MS = 60_000
// Phones get a flat list (see index.css), and some visitors ask for no motion.
const STILL = '(prefers-reduced-motion: reduce), (max-width: 640px)'
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

type SphereStyle = React.CSSProperties & Record<`--${string}`, string>

type Props = {
  names: readonly string[]
  onPick: (name: string) => void
}

// The i-th of n points spread evenly over the unit sphere (a Fibonacci lattice).
export function spherePoint(i: number, n: number): Point {
  const y = 1 - (2 * (i + 0.5)) / n
  const r = Math.sqrt(1 - y * y)
  const theta = i * GOLDEN_ANGLE
  return { x: r * Math.cos(theta), y, z: r * Math.sin(theta) }
}

export function spherePoints(n: number): Point[] {
  return Array.from({ length: n }, (_, i) => spherePoint(i, n))
}

// Where a point is drawn once the sphere has turned by `angle` about its vertical axis.
export function project(point: Point, angle: number): Placed {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const x = point.x * cos + point.z * sin
  const z = point.z * cos - point.x * sin
  const depth = (z + 1) / 2
  return {
    x,
    y: point.y,
    scale: 0.65 + 0.45 * depth,
    // Never below 0.65 of the text colour, which keeps 4.5:1 contrast in both themes;
    // size and stacking show depth.
    opacity: 0.65 + 0.35 * depth,
    layer: Math.round(depth * 100),
  }
}

function place(p: Placed): SphereStyle {
  return {
    '--x': p.x.toFixed(4),
    '--y': p.y.toFixed(4),
    '--scale': p.scale.toFixed(3),
    '--opacity': p.opacity.toFixed(3),
    '--layer': String(p.layer),
  }
}

// Featured drugs as a slowly turning sphere of names. Each name is a plain button, so the
// list reads and tabs like any other; the motion is only CSS variables set each frame.
export function DrugSphere({ names, onPick }: Props): React.JSX.Element {
  const items = useMemo(
    () => names.map((name, i) => ({ name, point: spherePoint(i, names.length) })),
    [names],
  )
  const nodes = useRef<(HTMLLIElement | null)[]>([])
  // Paused while the pointer is over the sphere or one of its names has focus.
  const hovered = useRef(false)
  const focused = useRef(false)

  useEffect(() => {
    // Without matchMedia the sphere is drawn once and stays still.
    if (typeof window.matchMedia !== 'function') return
    const still = window.matchMedia(STILL)
    let angle = 0
    let last: number | null = null
    let frame = 0
    function tick(now: number): void {
      if (last !== null && !hovered.current && !focused.current) {
        angle += ((now - last) / TURN_MS) * 2 * Math.PI
        items.forEach((item, i) => {
          const node = nodes.current[i]
          if (!node) return
          for (const [name, value] of Object.entries(place(project(item.point, angle)))) {
            node.style.setProperty(name, value)
          }
        })
      }
      last = now
      frame = requestAnimationFrame(tick)
    }
    // Follows the visitor's setting and the window's width as they change.
    function update(): void {
      cancelAnimationFrame(frame)
      last = null
      if (!still.matches) frame = requestAnimationFrame(tick)
    }
    update()
    still.addEventListener('change', update)
    return () => {
      still.removeEventListener('change', update)
      cancelAnimationFrame(frame)
    }
  }, [items])

  return (
    <div className="home-sphere">
      <ul
        className="sphere"
        aria-label="Drugs to try"
        onPointerEnter={() => {
          hovered.current = true
        }}
        onPointerLeave={() => {
          hovered.current = false
        }}
        onFocus={() => {
          focused.current = true
        }}
        onBlur={() => {
          focused.current = false
        }}
      >
        {items.map((item, i) => (
          <li
            key={item.name}
            ref={(node) => {
              nodes.current[i] = node
            }}
            style={place(project(item.point, 0))}
          >
            <button type="button" onClick={() => onPick(item.name)}>
              {item.name}
            </button>
          </li>
        ))}
      </ul>
      <p className="sphere-note">A few drugs to try. Search works for other drugs too.</p>
    </div>
  )
}
