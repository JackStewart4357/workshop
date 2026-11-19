import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useShowMore } from './useShowMore.js'

const rows = (count) => Array.from({ length: count }, (_, index) => `row ${index + 1}`)

describe('useShowMore', () => {
  it('shows a short list whole, with nothing more to ask for', () => {
    const { result } = renderHook(() => useShowMore(rows(3), 20))
    expect(result.current).toMatchObject({ visible: rows(3), shown: 3, total: 3, hasMore: false })
  })

  it('shows a long list a page at a time until all of it is on screen', () => {
    const { result } = renderHook(() => useShowMore(rows(45), 20))
    expect(result.current).toMatchObject({ shown: 20, total: 45, pageSize: 20, hasMore: true })
    expect(result.current.visible).toEqual(rows(45).slice(0, 20))

    act(() => result.current.showMore())
    expect(result.current).toMatchObject({ shown: 40, hasMore: true })

    act(() => result.current.showMore())
    expect(result.current).toMatchObject({ shown: 45, hasMore: false })
    expect(result.current.visible).toEqual(rows(45))
  })

  it('starts again at the first page when a search changes how many rows there are', () => {
    const { result, rerender } = renderHook(({ list }) => useShowMore(list, 20), { initialProps: { list: rows(100) } })
    act(() => result.current.showMore())
    expect(result.current.shown).toBe(40)

    rerender({ list: rows(30) })
    expect(result.current).toMatchObject({ shown: 20, total: 30, hasMore: true })
  })

  it('keeps its place when the rows change but their number does not', () => {
    const { result, rerender } = renderHook(({ list }) => useShowMore(list, 20), { initialProps: { list: rows(100) } })
    act(() => result.current.showMore())
    rerender({ list: rows(100).reverse() }) // a reload after an edit
    expect(result.current.shown).toBe(40)
  })

  it('starts again when the caller says the list is a different one, whatever its length', () => {
    const { result, rerender } = renderHook(({ key }) => useShowMore(rows(100), 25, key), {
      initialProps: { key: 'status=OPEN' },
    })
    act(() => result.current.showMore())
    expect(result.current.shown).toBe(50)

    rerender({ key: 'status=CLOSED' })
    expect(result.current.shown).toBe(25)
    act(() => result.current.showMore())
    expect(result.current.shown).toBe(50)
  })
})
