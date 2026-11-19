// Form checks that mirror the API's rules (backend/auth, facilities, engineers, incidents
// and feedback), so most mistakes are caught before a request is sent. The API still
// validates everything: these are for speed and clearer feedback, not for security. Each
// returns an error message or ''.

export const EMAIL_DOMAIN = 'acme.inc'
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_BYTES = 72
export const NAME_MAX_LENGTH = 100
export const ADDRESS_MAX_LENGTH = 200
export const SEAT_CODE_MAX_LENGTH = 20
export const FLOOR_MIN = -5
export const FLOOR_MAX = 200
export const SPECIALISM_MAX_LENGTH = 100
export const TICKETS_MIN = 1
export const TICKETS_MAX = 50
export const TITLE_MAX_LENGTH = 150
export const DESCRIPTION_MAX_LENGTH = 4000
export const NOTE_MAX_LENGTH = 2000
export const REASON_MAX_LENGTH = 500
export const COMMENT_MAX_LENGTH = 1000

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

/** For a field that may be left empty, but not be too long. */
export function validateOptional(label, maxLength) {
  return (value) => (value.trim().length > maxLength ? `${label} must be at most ${maxLength} characters` : '')
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

export function validateFloorLevel(value) {
  if (!/^-?\d+$/.test(value.trim())) return 'Enter a whole number (0 is the ground floor)'
  const level = Number(value)
  if (level < FLOOR_MIN || level > FLOOR_MAX) return `Floor must be between ${FLOOR_MIN} and ${FLOOR_MAX}`
  return ''
}

/** How many open tickets an engineer can hold at once. */
export function validateMaxTickets(value) {
  const tickets = /^\d+$/.test(value.trim()) ? Number(value) : NaN
  if (tickets >= TICKETS_MIN && tickets <= TICKETS_MAX) return ''
  return `Max open tickets must be a whole number from ${TICKETS_MIN} to ${TICKETS_MAX}`
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
