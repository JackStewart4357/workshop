import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Puts keyboard focus back into a form after a failed submit. The fields and the submit
 * button are disabled while a request is in flight, and browsers drop focus from a disabled
 * element. Focusing the field also makes a screen reader read its error text.
 * Returns [formRef, focusAfterFailure]. The first field marked invalid gets the focus; if
 * the error is only a banner, the field called `fallbackName` does.
 */
export function useFocusAfterFailedSubmit(fallbackName) {
  const formRef = useRef(null)
  const [failures, setFailures] = useState(0)

  // Runs after the re-render, once the fields are enabled again and carry aria-invalid.
  useEffect(() => {
    const form = formRef.current
    if (failures === 0 || !form) return
    const target = form.querySelector('[aria-invalid="true"]') || form.elements.namedItem(fallbackName)
    target?.focus()
  }, [failures, fallbackName])

  const focusAfterFailure = useCallback(() => setFailures((count) => count + 1), [])
  return [formRef, focusAfterFailure]
}
