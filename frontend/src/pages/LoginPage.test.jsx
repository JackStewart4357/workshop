import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import LoginPage from './LoginPage.jsx'
import { ApiError } from '../services/apiClient.js'
import { USERS, renderWithProviders } from '../test/helpers.jsx'

function renderLogin({ auth = {}, entry = '/login' } = {}) {
  const login = auth.login ?? vi.fn().mockResolvedValue()
  renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<p>register page</p>} />
      <Route path="/" element={<p>dashboard</p>} />
      <Route path="/incidents/7" element={<p>incident seven</p>} />
    </Routes>,
    { auth: { user: null, ...auth, login }, route: entry },
  )
  return { login, user: userEvent.setup() }
}

async function fillAndSubmit(user, { email = 'alice@acme.inc', password = 'passw0rd1' } = {}) {
  if (email) await user.type(screen.getByLabelText(/email/i), email)
  if (password) await user.type(screen.getByLabelText(/^password/i), password)
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
}

describe('LoginPage', () => {
  it('signs in and goes to the dashboard', async () => {
    const { login, user } = renderLogin()
    await fillAndSubmit(user, { email: '  alice@acme.inc ' })
    expect(login).toHaveBeenCalledWith('alice@acme.inc', 'passw0rd1')
    expect(await screen.findByText('dashboard')).toBeInTheDocument()
  })

  it('returns to the page the visitor was trying to open', async () => {
    const { user } = renderLogin({ entry: { pathname: '/login', state: { from: '/incidents/7' } } })
    await fillAndSubmit(user)
    expect(await screen.findByText('incident seven')).toBeInTheDocument()
  })

  it('does not trim the password', async () => {
    const { login, user } = renderLogin()
    await fillAndSubmit(user, { password: ' passw0rd1 ' })
    expect(login).toHaveBeenCalledWith('alice@acme.inc', ' passw0rd1 ')
  })

  it('shows required-field errors beside the fields without calling the API', async () => {
    const { login, user } = renderLogin()
    await fillAndSubmit(user, { email: '', password: '' })
    expect(screen.getByText('Email is required')).toBeInTheDocument()
    expect(screen.getByText('Password is required')).toBeInTheDocument()
    expect(screen.getByLabelText(/email/i)).toBeInvalid()
    expect(login).not.toHaveBeenCalled()
  })

  it('clears a field error as soon as the field is edited', async () => {
    const { user } = renderLogin()
    await fillAndSubmit(user, { email: 'nope' })
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument()
    await user.type(screen.getByLabelText(/email/i), '@acme.inc')
    expect(screen.queryByText('Enter a valid email address')).not.toBeInTheDocument()
  })

  it('shows wrong-credential errors in a banner and lets the user retry', async () => {
    const login = vi
      .fn()
      .mockRejectedValueOnce(new ApiError({ status: 401, code: 'invalid_credentials', message: 'Incorrect email or password' }))
      .mockResolvedValueOnce()
    const { user } = renderLogin({ auth: { login } })
    await fillAndSubmit(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('dashboard')).toBeInTheDocument()
  })

  it('puts field errors from the API beside the matching field', async () => {
    const login = vi.fn().mockRejectedValue(
      new ApiError({ status: 400, code: 'validation_error', message: 'Some fields are invalid', details: { email: 'Enter a valid email address' } }),
    )
    const { user } = renderLogin({ auth: { login } })
    await fillAndSubmit(user)
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('disables the form while the request is in flight', async () => {
    let finish
    const login = vi.fn(() => new Promise((resolve) => (finish = resolve)))
    const { user } = renderLogin({ auth: { login } })
    await fillAndSubmit(user)
    expect(screen.getByLabelText(/email/i)).toBeDisabled()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeDisabled()
    finish()
    await waitFor(() => expect(screen.getByText('dashboard')).toBeInTheDocument())
  })

  it('after wrong credentials the keyboard is back in the password field', async () => {
    const login = vi
      .fn()
      .mockRejectedValue(new ApiError({ status: 401, code: 'invalid_credentials', message: 'Incorrect email or password' }))
    const { user } = renderLogin({ auth: { login } })
    await fillAndSubmit(user, { password: 'wrongpass1' })
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password')
    expect(screen.getByLabelText(/^password/i)).toHaveFocus()
    await user.keyboard('XYZ')
    expect(screen.getByLabelText(/^password/i)).toHaveValue('wrongpass1XYZ')
  })

  it('moves focus to the first field with a problem', async () => {
    const { user } = renderLogin()
    await fillAndSubmit(user, { email: '' })
    expect(screen.getByLabelText(/email/i)).toHaveFocus()
    expect(screen.getByLabelText(/email/i)).toHaveAccessibleDescription('Email is required')
  })

  it('waits for the start-up session check before offering the form', () => {
    renderLogin({ auth: { status: 'loading' } })
    expect(screen.getByRole('progressbar', { name: 'Checking your session' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('explains that the session expired, until a sign-in error takes its place', async () => {
    const login = vi
      .fn()
      .mockRejectedValue(new ApiError({ status: 401, code: 'invalid_credentials', message: 'Incorrect email or password' }))
    const { user } = renderLogin({ auth: { login, sessionEnd: 'expired' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Your session has expired. Please sign in again.')
    await fillAndSubmit(user)
    expect(await screen.findByText('Incorrect email or password')).toBeInTheDocument()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('does not bring the expired notice back once a sign-in has been tried', async () => {
    const { user } = renderLogin({ auth: { sessionEnd: 'expired' } })
    await fillAndSubmit(user, { email: '' })
    expect(screen.getByText('Email is required')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says nothing about the session after a deliberate sign-out', () => {
    renderLogin({ auth: { sessionEnd: 'signed-out' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('can show and hide the password', async () => {
    const { user } = renderLogin()
    const password = screen.getByLabelText(/^password/i)
    expect(password).toHaveAttribute('type', 'password')
    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(password).toHaveAttribute('type', 'text')
    await user.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(password).toHaveAttribute('type', 'password')
  })

  it('links to registration', async () => {
    const { user } = renderLogin()
    await user.click(screen.getByRole('link', { name: 'Create an account' }))
    expect(screen.getByText('register page')).toBeInTheDocument()
  })

  it('skips the form when already signed in', () => {
    renderLogin({ auth: { user: USERS.employee } })
    expect(screen.getByText('dashboard')).toBeInTheDocument()
  })
})
