import { useState } from 'react'

/**
 * Shows a long list a page at a time, so a screen with hundreds of rows opens short and
 * grows only when asked: "Show 20 more".
 *
 *   visible    the rows to draw now
 *   shown      how many that is; total is how many there are
 *   hasMore    whether there are rows not drawn yet
 *   showMore   draw one more page
 *
 * A different list starts again at the first page. By default "different" means its length
 * changed (a search, an addition, a removal); pass `resetKey` when something else says so,
 * such as the filters a list was asked for.
 */
export function useShowMore(list, pageSize, resetKey = list.length) {
  const [page, setPage] = useState({ key: resetKey, shown: pageSize })
  const wanted = page.key === resetKey ? page.shown : pageSize
  const shown = Math.min(wanted, list.length)
  return {
    visible: list.slice(0, shown),
    shown,
    total: list.length,
    pageSize,
    hasMore: shown < list.length,
    showMore: () => setPage({ key: resetKey, shown: wanted + pageSize }),
  }
}
