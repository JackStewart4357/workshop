import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import RegisterPage from './RegisterPage.jsx'
import { ApiError } from '../services/apiClient.js'
import { USERS, renderWithProviders } from '../test/helpers.jsx'

const VALID = { name: 'Alice Johnson', email: 'alice@acme.inc', password: 'passw0rd1', confirm: 'passw0rd1' }

function renderRegister({ auth = {} } = {}) {
  const register = auth.register ?? vi.fn().mockResolvedValue()
  renderWithProviders(
    <Routes>
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/login" element={<p>login page</p>} />
      <Route path="/" element={<p>dashboard</p>} />
    </Routes>,
    { auth: { user: null, ...auth, register }, route: '/register' },
  )
  return { register, user: userEvent.setup() }
}

async function fillAndSubmit(user, overrides = {}) {
  const values = { ...VALID, ...overrides }
  if (values.name) await user.type(screen.getByLabelText(/full name/i), values.name)
  if (values.email) await user.type(screen.getByLabelText(/work email/i), values.email)
  if (values.password) await user.type(screen.getByLabelText(/^password/i), values.password)
  if (values.confirm) await user.type(screen.getByLabelText(/confirm password/i), values.confirm)
  await user.click(screen.getByRole('button', { name: 'Create account' }))
}

describe('RegisterPage', () => {
  it('creates the account and goes to the dashboard', async () => {
    const { register, user } = renderRegister()
    await fillAndSubmit(user, { name: '  Alice Johnson ', email: ' alice@acme.inc ' })
    expect(register).toHaveBeenCalledWith({ fullName: 'Alice Johnson', email: 'alice@acme.inc', password: 'passw0rd1' })
    expect(await screen.findByText('dashboard')).toBeInTheDocument()
  })

  it('explains the rules before anything is typed', () => {
    renderRegister()
    expect(screen.getByText('Must end in @acme.inc')).toBeInTheDocument()
    expect(screen.getByText('At least 8 characters, with a letter and a number')).toBeInTheDocument()
  })

  it.each([
    [{ name: '' }, 'Full name is required'],
    [{ email: 'alice@gmail.com' }, 'Only @acme.inc email addresses can register'],
    [{ email: 'not-an-email' }, 'Enter a valid email address'],
    [{ password: 'short1', confirm: 'short1' }, 'Password must be at least 8 characters'],
    [{ password: 'lettersonly', confirm: 'lettersonly' }, 'Password must contain at least one letter and one number'],
    [{ confirm: 'different1' }, 'Passwords do not match'],
  ])('rejects %j before calling the API', async (overrides, message) => {
    const { register, user } = renderRegister()
    await fillAndSubmit(user, overrides)
    expect(screen.getByText(message)).toBeInTheDocument()
    expect(register).not.toHaveBeenCalled()
  })

  it('shows every problem at once', async () => {
    const { user } = renderRegister()
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(screen.getByText('Full name is required')).toBeInTheDocument()
    expect(screen.getByText('Email is required')).toBeInTheDocument()
    expect(screen.getByText('Password is required')).toBeInTheDocument()
    expect(screen.getByLabelText(/full name/i)).toHaveFocus()
  })

  it('shows "email already exists" from the API beside the email field', async () => {
    const message = 'An account with this email already exists'
    const register = vi
      .fn()
      .mockRejectedValue(new ApiError({ status: 409, code: 'conflict', message, details: { email: message } }))
    const { user } = renderRegister({ auth: { register } })
    await fillAndSubmit(user)
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.getByLabelText(/work email/i)).toBeInvalid()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled()
  })

  it('shows a network failure in a banner', async () => {
    const register = vi.fn().mockRejectedValue(
      new ApiError({ status: 0, code: 'network_error', message: 'Cannot reach the server. Check your connection and try again.' }),
    )
    const { user } = renderRegister({ auth: { register } })
    await fillAndSubmit(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server')
  })

  it('moves focus to the field the API rejected', async () => {
    const message = 'An account with this email already exists'
    const register = vi
      .fn()
      .mockRejectedValue(new ApiError({ status: 409, code: 'conflict', message, details: { email: message } }))
    const { user } = renderRegister({ auth: { register } })
    await fillAndSubmit(user)
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.getByLabelText(/work email/i)).toHaveFocus()
  })

  it('moves focus to the first field when the error is only a banner', async () => {
    const register = vi.fn().mockRejectedValue(
      new ApiError({ status: 0, code: 'network_error', message: 'Cannot reach the server. Check your connection and try again.' }),
    )
    const { user } = renderRegister({ auth: { register } })
    await fillAndSubmit(user)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByLabelText(/full name/i)).toHaveFocus()
  })

  it('waits for the start-up session check before offering the form', () => {
    renderRegister({ auth: { status: 'loading' } })
    expect(screen.getByRole('progressbar', { name: 'Checking your session' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('links back to sign in', async () => {
    const { user } = renderRegister()
    await user.click(screen.getByRole('link', { name: 'Sign in' }))
    expect(screen.getByText('login page')).toBeInTheDocument()
  })

  it('skips the form when already signed in', () => {
    renderRegister({ auth: { user: USERS.employee } })
    expect(screen.getByText('dashboard')).toBeInTheDocument()
  })
})
