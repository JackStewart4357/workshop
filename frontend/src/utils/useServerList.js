import { useCallback, useEffect, useState } from 'react'

/**
 * The state behind an admin screen that shows a list held by the server and changes it.
 * `fetchItems` must be the same function on every render (a service function, or one
 * declared outside the component).
 *
 *   items       what the server returned; null until the first load finishes
 *   loadError   why the list could not be loaded ('' when it could); retry() tries again
 *   error       why the last removal failed, for a page-level alert; setError('') clears it
 *   busy        true while a change is being sent and the list reloaded
 *   change(fn)  send a change, then reload. Resolves with the error, or null when it worked
 *   removing    the removal waiting for confirmation: { what, note, run }; set by setRemoving
 */
export function useServerList(fetchItems) {
  const [items, setItems] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState(null)

  const load = useCallback(
    () =>
      fetchItems().then(
        (found) => {
          setItems(found)
          setLoadError('') // a load that worked replaces an earlier failure
        },
        (failure) => setLoadError(failure.message),
      ),
    [fetchItems],
  )
  useEffect(() => {
    load()
  }, [load])

  function retry() {
    setLoadError('')
    load()
  }

  // Every change goes through here: send it, then reload everything so the screen shows
  // what the server holds.
  async function change(action) {
    setBusy(true)
    setError('')
    try {
      await action()
      await load() // if only the reload fails, the change still happened: load() offers "Try again"
      return null
    } catch (failure) {
      return failure
    } finally {
      setBusy(false)
    }
  }

  async function confirmRemove() {
    const failure = await change(removing.run)
    setRemoving(null)
    if (failure) setError(failure.message) // e.g. "This building is used by incidents..."
  }

  return { items, loadError, retry, error, setError, busy, change, removing, setRemoving, confirmRemove }
}
