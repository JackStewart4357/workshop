import { describe, expect, it } from 'vitest'
import {
  validateCompanyEmail,
  validateEmail,
  validateForm,
  validateNewPassword,
  validateRequired,
} from './validation.js'

describe('validateEmail', () => {
  it.each(['alice@acme.inc', '  Alice@ACME.inc  ', 'a.b+c@sub.example.com'])('accepts %s', (value) => {
    expect(validateEmail(value)).toBe('')
  })

  it('requires a value', () => {
    expect(validateEmail('   ')).toBe('Email is required')
  })

  it.each(['plain', '@acme.inc', 'a@b', 'a b@acme.inc'])('rejects %s', (value) => {
    expect(validateEmail(value)).toBe('Enter a valid email address')
  })
})

describe('validateCompanyEmail', () => {
  it('accepts the company domain in any case', () => {
    expect(validateCompanyEmail('Bob@Acme.Inc')).toBe('')
  })

  it.each(['bob@gmail.com', 'bob@acme.inc.evil.com', 'bob@notacme.inc'])('rejects %s', (value) => {
    expect(validateCompanyEmail(value)).toBe('Only @acme.inc email addresses can register')
  })

  it('reports a malformed address before the domain', () => {
    expect(validateCompanyEmail('nope')).toBe('Enter a valid email address')
  })
})

describe('validateNewPassword', () => {
  it.each(['eight888', 'a1' + 'x'.repeat(70), ' passw0rd1 '])('accepts %s', (value) => {
    expect(validateNewPassword(value)).toBe('')
  })

  it.each([
    ['', 'Password is required'],
    ['seven77', 'Password must be at least 8 characters'],
    ['lettersonly', 'Password must contain at least one letter and one number'],
    ['1234567890', 'Password must contain at least one letter and one number'],
    ['a1' + 'x'.repeat(71), 'Password must be at most 72 bytes'],
    ['a1' + 'é'.repeat(36), 'Password must be at most 72 bytes'], // 38 characters, 74 bytes
  ])('rejects %j', (value, message) => {
    expect(validateNewPassword(value)).toBe(message)
  })
})

describe('validateRequired', () => {
  const validate = validateRequired('Full name', 5)

  it('requires a non-blank value', () => {
    expect(validate('  ')).toBe('Full name is required')
  })

  it('measures length after trimming', () => {
    expect(validate('  abcde  ')).toBe('')
    expect(validate('abcdef')).toBe('Full name must be at most 5 characters')
  })
})

describe('validateForm', () => {
  it('returns only the fields that failed', () => {
    const rules = { email: validateEmail, name: validateRequired('Name', 10) }
    expect(validateForm({ email: 'nope', name: 'Ada' }, rules)).toEqual({ email: 'Enter a valid email address' })
  })

  it('treats a missing value as empty', () => {
    expect(validateForm({}, { email: validateEmail })).toEqual({ email: 'Email is required' })
  })
})
