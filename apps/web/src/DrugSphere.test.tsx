import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DrugSphere, project, spherePoints } from './DrugSphere.tsx'

type Query = { matches: boolean; set: (matches: boolean) => void }

// The sphere's media query, whose answer a test can change while the sphere is shown.
function reduceMotion(reduce: boolean): Query {
  const listeners = new Set<() => void>()
  const query = {
    matches: reduce,
    media: '',
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    set(matches: boolean): void {
      query.matches = matches
      for (const listener of listeners) listener()
    },
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  )
  return query
}

type Frames = { run: (now: number) => void; pending: () => number }

// Animation frames that run only when the test says, at the time it gives.
function controlFrames(): Frames {
  let queue = new Map<number, FrameRequestCallback>()
  let next = 1
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      queue.set(next, callback)
      return next++
    }),
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => queue.delete(id)),
  )
  return {
    run(now: number): void {
      const due = [...queue.values()]
      queue = new Map()
      for (const callback of due) callback(now)
    },
    pending: () => queue.size,
  }
}

// Where the named drug is drawn across the sphere.
function across(name: string): string {
  const item = screen.getByRole('button', { name }).closest('li')
  if (!item) throw new Error(`No list item for ${name}`)
  return item.style.getPropertyValue('--x')
}

// A quarter of a turn, in milliseconds.
const QUARTER = 15_000

describe('spherePoints', () => {
  it('spreads the points over the unit sphere', () => {
    const points = spherePoints(40)

    expect(points).toHaveLength(40)
    for (const p of points) expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(1, 10)
    const keys = new Set(points.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`))
    expect(keys.size).toBe(40)
  })
})

describe('project', () => {
  it('draws nearer points larger, brighter and on top', () => {
    const near = project({ x: 0, y: 0, z: 1 }, 0)
    const far = project({ x: 0, y: 0, z: -1 }, 0)

    expect(near.scale).toBeGreaterThan(far.scale)
    expect(near.opacity).toBeGreaterThan(far.opacity)
    expect(near.layer).toBeGreaterThan(far.layer)
    expect(near.opacity).toBeLessThanOrEqual(1)
  })

  it('keeps the farthest names readable', () => {
    // At 0.65 of the text colour the names keep at least 4.5:1 contrast in both themes.
    expect(project({ x: 0, y: 0, z: -1 }, 0).opacity).toBeGreaterThanOrEqual(0.65)
  })

  it('turns the sphere about its vertical axis', () => {
    const turned = project({ x: 1, y: 0, z: 0 }, Math.PI / 2)

    expect(turned.x).toBeCloseTo(0, 10)
    expect(turned.y).toBeCloseTo(0, 10)
  })
})

describe('DrugSphere', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('offers each featured drug as a button', () => {
    reduceMotion(true)
    render(<DrugSphere names={['ibuprofen', 'Tylenol PM']} onPick={() => {}} />)
    const list = screen.getByRole('list', { name: 'Drugs to try' })

    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['ibuprofen', 'Tylenol PM'])
  })

  it('picks the drug that is clicked', () => {
    reduceMotion(true)
    const onPick = vi.fn()
    render(<DrugSphere names={['ibuprofen', 'Tylenol PM']} onPick={onPick} />)
    fireEvent.click(screen.getByRole('button', { name: 'Tylenol PM' }))

    expect(onPick).toHaveBeenCalledWith('Tylenol PM')
  })

  it('stays still when the visitor asks for reduced motion', () => {
    reduceMotion(true)
    const frames = controlFrames()
    render(<DrugSphere names={['ibuprofen']} onPick={() => {}} />)

    expect(frames.pending()).toBe(0)
  })

  it('turns the names when motion is allowed', () => {
    reduceMotion(false)
    const frames = controlFrames()
    render(<DrugSphere names={['ibuprofen']} onPick={() => {}} />)
    const start = across('ibuprofen')
    frames.run(0)
    frames.run(QUARTER)

    expect(across('ibuprofen')).not.toBe(start)
  })

  it('stops when reduced motion is turned on, and turns again when it is off', () => {
    const query = reduceMotion(false)
    const frames = controlFrames()
    render(<DrugSphere names={['ibuprofen']} onPick={() => {}} />)
    frames.run(0)

    query.set(true)
    expect(frames.pending()).toBe(0)

    query.set(false)
    expect(frames.pending()).toBe(1)
  })

  it('stays still while a name has focus, even once the pointer leaves', () => {
    reduceMotion(false)
    const frames = controlFrames()
    render(<DrugSphere names={['ibuprofen']} onPick={() => {}} />)
    const list = screen.getByRole('list', { name: 'Drugs to try' })
    frames.run(0)
    const start = across('ibuprofen')

    fireEvent.pointerEnter(list)
    act(() => screen.getByRole('button', { name: 'ibuprofen' }).focus())
    fireEvent.pointerLeave(list)
    frames.run(QUARTER)
    expect(across('ibuprofen')).toBe(start)

    act(() => screen.getByRole('button', { name: 'ibuprofen' }).blur())
    frames.run(2 * QUARTER)
    expect(across('ibuprofen')).not.toBe(start)
  })

  it('stays still while the pointer is over it, even once focus leaves', () => {
    reduceMotion(false)
    const frames = controlFrames()
    render(<DrugSphere names={['ibuprofen']} onPick={() => {}} />)
    const list = screen.getByRole('list', { name: 'Drugs to try' })
    frames.run(0)
    const start = across('ibuprofen')

    act(() => screen.getByRole('button', { name: 'ibuprofen' }).focus())
    fireEvent.pointerEnter(list)
    act(() => screen.getByRole('button', { name: 'ibuprofen' }).blur())
    frames.run(QUARTER)
    expect(across('ibuprofen')).toBe(start)

    fireEvent.pointerLeave(list)
    frames.run(2 * QUARTER)
    expect(across('ibuprofen')).not.toBe(start)
  })

  it('says search works for other drugs too', () => {
    reduceMotion(true)
    render(<DrugSphere names={['ibuprofen']} onPick={() => {}} />)

    expect(screen.getByText(/search works for other drugs too/i)).toBeInTheDocument()
  })
})
