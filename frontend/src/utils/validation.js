// Form checks that mirror the API's rules (backend/auth/function.py), so most mistakes are
// caught before a request is sent. The API still validates everything: these are for speed
// and clearer feedback, not for security. Each returns an error message or ''.

export const EMAIL_DOMAIN = 'acme.inc'
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_BYTES = 72
export const NAME_MAX_LENGTH = 100

const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/

export function validateEmail(value) {
  const email = value.trim().toLowerCase()
  if (!email) return 'Email is required'
  if (!EMAIL_PATTERN.test(email)) return 'Enter a valid email address'
  return ''
}

export function validateCompanyEmail(value) {
  const error = validateEmail(value)
  if (error) return error
  if (!value.trim().toLowerCase().endsWith(`@${EMAIL_DOMAIN}`)) {
    return `Only @${EMAIL_DOMAIN} email addresses can register`
  }
  return ''
}

export function validateRequired(label, maxLength) {
  return (value) => {
    if (!value.trim()) return `${label} is required`
    if (value.trim().length > maxLength) return `${label} must be at most ${maxLength} characters`
    return ''
  }
}

export function validateNewPassword(value) {
  if (!value) return 'Password is required'
  if (value.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
  if (new TextEncoder().encode(value).length > PASSWORD_MAX_BYTES) {
    return `Password must be at most ${PASSWORD_MAX_BYTES} bytes`
  }
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    return 'Password must contain at least one letter and one number'
  }
  return ''
}

// Run {field: validator} over the form values; returns only the fields that failed.
export function validateForm(values, rules) {
  const errors = {}
  for (const [field, validate] of Object.entries(rules)) {
    const message = validate(values[field] ?? '')
    if (message) errors[field] = message
  }
  return errors
}
