import { useState } from 'react'
import { useFocusAfterFailedSubmit } from './useFocusAfterFailedSubmit.js'
import { validateForm } from './validation.js'

/**
 * The logic of a form in a dialog: check the fields, lock the form while it is being
 * saved, put the API's complaints under the right field, and close when it worked.
 *
 *   initial     the starting values, keyed by field name (the API's names, so its
 *               per-field messages land on the right input without any mapping)
 *   rules       { field: validator } as taken by validateForm
 *   toRequest   turns the form values into what is sent (trimming, numbers)
 *   onSave      sends it; resolves with the error, or null when it worked
 *   onClose     closes the dialog
 *   firstField  where the keyboard goes when a failure belongs to no single field
 */
export function useDialogForm({ initial, rules, toRequest, onSave, onClose, firstField }) {
  const [values, setValues] = useState(initial)
  const [fieldErrors, setFieldErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [formRef, focusAfterFailure] = useFocusAfterFailedSubmit(firstField)

  // Text fields and selects carry their value in `value`; switches and checkboxes in `checked`.
  function handleChange(event) {
    const { name, type, checked, value } = event.target
    setValues((current) => ({ ...current, [name]: type === 'checkbox' ? checked : value }))
    setFieldErrors((current) => ({ ...current, [name]: '' }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    const errors = validateForm(values, rules)
    setFieldErrors(errors)
    setFormError('')
    if (Object.keys(errors).length > 0) {
      focusAfterFailure()
      return
    }

    setSaving(true)
    const failure = await onSave(toRequest(values))
    if (!failure) {
      onClose()
      return
    }
    setFieldErrors(failure.fieldErrors)
    // A complaint about a field this form does not show would otherwise be invisible
    if (!Object.keys(failure.fieldErrors).some((name) => name in values)) setFormError(failure.message)
    setSaving(false)
    focusAfterFailure()
  }

  /** The props every text field or select of the form needs; `hint` shows while there is no error. */
  function field(name, hint) {
    return {
      name,
      value: values[name],
      onChange: handleChange,
      error: Boolean(fieldErrors[name]),
      helperText: fieldErrors[name] || hint,
      disabled: saving,
    }
  }

  return { values, formError, saving, formRef, handleChange, handleSubmit, field }
}
