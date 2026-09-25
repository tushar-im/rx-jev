import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DrugSphere, project, spherePoints } from './DrugSphere.tsx'

function reduceMotion(reduce: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: reduce, media: query })),
  )
}

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
    const frame = vi.spyOn(window, 'requestAnimationFrame')
    render(<DrugSphere names={['ibuprofen']} onPick={() => {}} />)

    expect(frame).not.toHaveBeenCalled()
  })

  it('turns when motion is allowed', () => {
    reduceMotion(false)
    const frame = vi.spyOn(window, 'requestAnimationFrame')
    render(<DrugSphere names={['ibuprofen']} onPick={() => {}} />)

    expect(frame).toHaveBeenCalled()
  })

  it('says search works for other drugs too', () => {
    reduceMotion(true)
    render(<DrugSphere names={['ibuprofen']} onPick={() => {}} />)

    expect(screen.getByText(/search works for other drugs too/i)).toBeInTheDocument()
  })
})
