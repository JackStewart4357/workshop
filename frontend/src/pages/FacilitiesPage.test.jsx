// The page against a small fake facilities API: only fetch is faked.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import FacilitiesPage from './FacilitiesPage.jsx'
import { apiError, mockApi, renderWithProviders } from '../test/helpers.jsx'

const API = '/api/facilities'
const IN_USE = 'This building is used by incidents and cannot be removed'

// What the fake API holds; a handler changes it and the page's next GET shows the result.
let buildings
beforeEach(() => {
  buildings = [
    {
      id: 'b-1',
      name: 'Headquarters',
      address: '1 Acme Plaza, London',
      floors: [
        { id: 'f-b', level: -1, seats: [] },
        { id: 'f-0', level: 0, seats: [{ id: 's-1', code: 'GF-A01' }] },
        { id: 'f-2', level: 2, seats: [] },
      ],
    },
    { id: 'b-2', name: 'Riverside Annex', address: '25 Wharf Road, London', floors: [] },
  ]
})

async function renderPage(routes = {}) {
  const calls = mockApi({ [`GET ${API}/buildings`]: () => ({ body: { buildings } }), ...routes })
  renderWithProviders(<FacilitiesPage />)
  const user = userEvent.setup()
  await screen.findByRole('heading', { name: 'Facilities' })
  return { calls, user }
}

const headquarters = () => screen.getByRole('region', { name: 'Headquarters' })
const writes = (calls) => calls.filter((call) => call.method !== 'GET')

describe('FacilitiesPage', () => {
  it('shows a spinner, then every building with its floors and seats', async () => {
    mockApi({ [`GET ${API}/buildings`]: () => ({ body: { buildings } }) })
    renderWithProviders(<FacilitiesPage />)
    expect(screen.getByRole('progressbar', { name: 'Loading facilities' })).toBeInTheDocument()

    expect(await screen.findByRole('heading', { name: 'Headquarters' })).toBeInTheDocument()
    expect(within(headquarters()).getByText('1 Acme Plaza, London')).toBeInTheDocument()
    const floors = within(headquarters()).getAllByRole('group')
    expect(floors.map((floor) => floor.getAttribute('aria-label'))).toEqual(['Basement 1', 'Ground floor', 'Floor 2'])
    expect(within(floors[1]).getByText('GF-A01')).toBeInTheDocument()
    expect(within(floors[2]).getByText('No seats yet')).toBeInTheDocument()
    expect(within(floors[1]).queryByText('No seats yet')).not.toBeInTheDocument()
    expect(screen.queryByText('There are no buildings yet.')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Riverside Annex' })).toBeInTheDocument()
  })

  it('says so when there are no buildings yet', async () => {
    buildings = []
    await renderPage()
    expect(screen.getByText('There are no buildings yet.')).toBeInTheDocument()
  })

  it('offers to try again when the buildings cannot be loaded', async () => {
    let online = false
    mockApi({
      [`GET ${API}/buildings`]: () =>
        online ? { body: { buildings } } : apiError(500, 'internal_error', 'An unexpected error occurred'),
    })
    renderWithProviders(<FacilitiesPage />)
    const user = userEvent.setup()
    expect(await screen.findByRole('alert')).toHaveTextContent('An unexpected error occurred')

    online = true
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Headquarters' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('adds a building and shows it', async () => {
    const { calls, user } = await renderPage({
      [`POST ${API}/buildings`]: ({ body }) => {
        buildings = [...buildings, { id: 'b-3', ...body, floors: [] }]
        return { status: 201, body: { building: buildings.at(-1) } }
      },
    })
    await user.click(screen.getByRole('button', { name: 'Add building' }))
    const dialog = screen.getByRole('dialog', { name: 'Add building' })
    await user.type(within(dialog).getByLabelText(/name/i), '  North Campus ')
    await user.type(within(dialog).getByLabelText(/address/i), '9 Mill Lane, Leeds')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('heading', { name: 'North Campus' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(writes(calls)).toHaveLength(1)
    expect(writes(calls)[0]).toMatchObject({
      method: 'POST',
      path: `${API}/buildings`,
      body: { name: 'North Campus', address: '9 Mill Lane, Leeds' },
    })
  })

  it('a change that was saved is not reported as failed when only the reload fails', async () => {
    let online = true
    const { user } = await renderPage({
      [`GET ${API}/buildings`]: () =>
        online ? { body: { buildings } } : apiError(502, 'unknown_error', 'Something went wrong. Please try again.'),
      [`POST ${API}/buildings`]: ({ body }) => {
        buildings.push({ id: 'b-3', ...body, floors: [] })
        online = false
        return { status: 201, body: { building: buildings.at(-1) } }
      },
    })
    await user.click(screen.getByRole('button', { name: 'Add building' }))
    await user.type(screen.getByLabelText(/^name/i), 'North Campus')
    await user.type(screen.getByLabelText(/^address/i), '9 Mill Lane')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // The form closes (the building exists) and the page offers to load the list again
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    online = true
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'North Campus' })).toBeInTheDocument()
  })

  it('checks the building form before sending anything', async () => {
    const { calls, user } = await renderPage()
    await user.click(screen.getByRole('button', { name: 'Add building' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('Name is required')).toBeInTheDocument()
    expect(screen.getByText('Address is required')).toBeInTheDocument()
    expect(screen.getByLabelText(/name/i)).toHaveFocus()
    expect(writes(calls)).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows "name already exists" from the API under the name field and keeps the form open', async () => {
    const message = 'A building with this name already exists'
    const { user } = await renderPage({
      [`POST ${API}/buildings`]: () => apiError(409, 'conflict', message, { name: message }),
    })
    await user.click(screen.getByRole('button', { name: 'Add building' }))
    await user.type(screen.getByLabelText(/name/i), 'Headquarters')
    await user.type(screen.getByLabelText(/address/i), 'Somewhere else')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.getByLabelText(/name/i)).toBeInvalid()
    expect(screen.getByLabelText(/name/i)).toHaveFocus()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('shows any other failure inside the building form', async () => {
    const { user } = await renderPage({
      [`POST ${API}/buildings`]: () => apiError(403, 'access_denied', 'You do not have permission'),
    })
    await user.click(screen.getByRole('button', { name: 'Add building' }))
    await user.type(screen.getByLabelText(/name/i), 'North Campus')
    await user.type(screen.getByLabelText(/address/i), '9 Mill Lane, Leeds')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('You do not have permission')
  })

  it('edits a building, starting from its current name and address', async () => {
    const { calls, user } = await renderPage({
      [`PATCH ${API}/buildings/b-1`]: ({ body }) => {
        buildings = [{ ...buildings[0], ...body }, buildings[1]]
        return { body: { building: { id: 'b-1', ...body } } }
      },
    })
    await user.click(screen.getByRole('button', { name: 'Edit Headquarters' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit building' })
    expect(within(dialog).getByLabelText(/name/i)).toHaveValue('Headquarters')
    expect(within(dialog).getByLabelText(/address/i)).toHaveValue('1 Acme Plaza, London')
    await user.clear(within(dialog).getByLabelText(/name/i))
    await user.type(within(dialog).getByLabelText(/name/i), 'Head Office')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('heading', { name: 'Head Office' })).toBeInTheDocument()
    expect(writes(calls)[0]).toMatchObject({
      method: 'PATCH',
      body: { name: 'Head Office', address: '1 Acme Plaza, London' },
    })
  })

  it('removes a building only after the admin confirms', async () => {
    const { calls, user } = await renderPage({
      [`DELETE ${API}/buildings/b-2`]: () => {
        buildings = buildings.slice(0, 1)
        return { status: 204 }
      },
    })
    await user.click(screen.getByRole('button', { name: 'Remove Riverside Annex' }))
    const dialog = screen.getByRole('dialog', { name: 'Remove Riverside Annex?' })
    expect(dialog).toHaveTextContent('Its floors and seats are removed with it. This cannot be undone.')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(writes(calls)).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Remove Riverside Annex' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Riverside Annex' })).not.toBeInTheDocument())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('explains why a building that incidents use cannot be removed, and keeps it', async () => {
    const { user } = await renderPage({ [`DELETE ${API}/buildings/b-1`]: () => apiError(409, 'conflict', IN_USE) })
    await user.click(screen.getByRole('button', { name: 'Remove Headquarters' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(IN_USE)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Headquarters' })).toBeInTheDocument()

    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('adds a floor by its number', async () => {
    const { calls, user } = await renderPage({
      [`POST ${API}/buildings/b-2/floors`]: ({ body }) => {
        buildings = [buildings[0], { ...buildings[1], floors: [{ id: 'f-9', level: body.level, seats: [] }] }]
        return { status: 201, body: { floor: { id: 'f-9', building_id: 'b-2', level: body.level } } }
      },
    })
    const annex = screen.getByRole('region', { name: 'Riverside Annex' })
    await user.type(within(annex).getByLabelText('Floor number'), '-2')
    await user.click(within(annex).getByRole('button', { name: 'Add floor' }))

    expect(await within(annex).findByRole('group', { name: 'Basement 2' })).toBeInTheDocument()
    expect(writes(calls)[0].body).toEqual({ level: -2 })
    expect(within(annex).getByLabelText('Floor number')).toHaveValue(null)
    expect(within(annex).getByLabelText('Floor number')).toHaveFocus()
  })

  it.each([
    ['', 'Enter a whole number (0 is the ground floor)'],
    ['1.5', 'Enter a whole number (0 is the ground floor)'],
    ['201', 'Floor must be between -5 and 200'],
  ])('rejects floor number "%s" without calling the API', async (typed, message) => {
    const { calls, user } = await renderPage()
    if (typed) await user.type(within(headquarters()).getByLabelText('Floor number'), typed)
    await user.click(within(headquarters()).getByRole('button', { name: 'Add floor' }))
    expect(within(headquarters()).getByText(message)).toBeInTheDocument()
    expect(writes(calls)).toEqual([])
  })

  it('shows "already has that floor" from the API under the floor field', async () => {
    const message = 'This building already has that floor'
    const { user } = await renderPage({
      [`POST ${API}/buildings/b-1/floors`]: () => apiError(409, 'conflict', message, { level: message }),
    })
    await user.type(within(headquarters()).getByLabelText('Floor number'), '2{Enter}')
    expect(await within(headquarters()).findByText(message)).toBeInTheDocument()
    expect(within(headquarters()).getByLabelText('Floor number')).toHaveValue(2)

    await user.type(within(headquarters()).getByLabelText('Floor number'), '3')
    expect(within(headquarters()).queryByText(message)).not.toBeInTheDocument()
  })

  it('removes a floor after confirmation', async () => {
    const { calls, user } = await renderPage({
      [`DELETE ${API}/floors/f-2`]: () => {
        buildings = [{ ...buildings[0], floors: buildings[0].floors.slice(0, 2) }, buildings[1]]
        return { status: 204 }
      },
    })
    await user.click(within(headquarters()).getByRole('button', { name: 'Remove Floor 2' }))
    const dialog = screen.getByRole('dialog', { name: 'Remove Floor 2 of Headquarters?' })
    expect(dialog).toHaveTextContent('Its seats are removed with it.')
    await user.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(within(headquarters()).queryByRole('group', { name: 'Floor 2' })).not.toBeInTheDocument())
    expect(writes(calls)).toHaveLength(1)
  })

  it('adds seats one after another without leaving the field', async () => {
    const { calls, user } = await renderPage({
      [`POST ${API}/floors/f-2/seats`]: ({ body }) => {
        const floors = buildings[0].floors.map((floor) =>
          floor.id === 'f-2' ? { ...floor, seats: [...floor.seats, { id: `s-${body.code}`, code: body.code }] } : floor,
        )
        buildings = [{ ...buildings[0], floors }, buildings[1]]
        return { status: 201, body: { seat: { id: `s-${body.code}`, floor_id: 'f-2', code: body.code } } }
      },
    })
    const floor = within(headquarters()).getByRole('group', { name: 'Floor 2' })
    await user.type(within(floor).getByLabelText('Seat code'), ' 2F-A01 {Enter}')
    expect(await within(floor).findByText('2F-A01')).toBeInTheDocument()
    expect(within(floor).getByLabelText('Seat code')).toHaveValue('')
    expect(within(floor).getByLabelText('Seat code')).toHaveFocus()

    await user.keyboard('2F-A02{Enter}')
    expect(await within(floor).findByText('2F-A02')).toBeInTheDocument()
    expect(writes(calls).map((call) => call.body)).toEqual([{ code: '2F-A01' }, { code: '2F-A02' }])
  })

  it('shows a seat problem under the seat field: a missing code, a duplicate, or a failure', async () => {
    const duplicate = 'This floor already has a seat with that code'
    let answer = () => apiError(409, 'conflict', duplicate, { code: duplicate })
    const { calls, user } = await renderPage({ [`POST ${API}/floors/f-0/seats`]: () => answer() })
    const floor = within(headquarters()).getByRole('group', { name: 'Ground floor' })

    await user.click(within(floor).getByRole('button', { name: 'Add seat' }))
    expect(within(floor).getByText('Seat code is required')).toBeInTheDocument()
    expect(writes(calls)).toEqual([])

    await user.type(within(floor).getByLabelText('Seat code'), 'GF-A01{Enter}')
    expect(await within(floor).findByText(duplicate)).toBeInTheDocument()
    expect(within(floor).getByLabelText('Seat code')).toHaveValue('GF-A01')

    answer = () => apiError(500, 'internal_error', 'An unexpected error occurred')
    await user.keyboard('{Enter}')
    expect(await within(floor).findByText('An unexpected error occurred')).toBeInTheDocument()
  })

  it('removes a seat after confirmation', async () => {
    const { calls, user } = await renderPage({
      [`DELETE ${API}/seats/s-1`]: () => {
        const floors = buildings[0].floors.map((floor) => ({ ...floor, seats: [] }))
        buildings = [{ ...buildings[0], floors }, buildings[1]]
        return { status: 204 }
      },
    })
    await user.click(screen.getByRole('img', { name: 'Remove seat GF-A01' }))
    expect(screen.getByRole('dialog', { name: 'Remove seat GF-A01?' })).toHaveTextContent('This cannot be undone.')
    await user.keyboard('{Escape}') // backing out any other way than Cancel removes nothing either
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes(calls)).toEqual([])

    await user.click(screen.getByRole('img', { name: 'Remove seat GF-A01' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(screen.queryByText('GF-A01')).not.toBeInTheDocument())
    expect(writes(calls)).toHaveLength(1)
  })

  it('holds the other controls while a change is being saved', async () => {
    let finish
    const { calls, user } = await renderPage({
      [`POST ${API}/floors/f-0/seats`]: () => new Promise((resolve) => (finish = resolve)),
    })
    const floor = within(headquarters()).getByRole('group', { name: 'Ground floor' })
    await user.type(within(floor).getByLabelText('Seat code'), 'GF-A02{Enter}')

    expect(screen.getByRole('button', { name: 'Add building' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove Headquarters' })).toBeDisabled()
    expect(within(floor).getByRole('button', { name: 'Add seat' })).toBeDisabled()
    await user.keyboard('{Enter}') // a second Enter must not send it twice
    expect(writes(calls)).toHaveLength(1)

    finish({ status: 201, body: { seat: { id: 's-2', floor_id: 'f-0', code: 'GF-A02' } } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add building' })).toBeEnabled())
  })

  it('holds the building form while it is being saved', async () => {
    let finish
    const { user } = await renderPage({
      [`POST ${API}/buildings`]: () => new Promise((resolve) => (finish = resolve)),
    })
    await user.click(screen.getByRole('button', { name: 'Add building' }))
    await user.type(screen.getByLabelText(/name/i), 'North Campus')
    await user.type(screen.getByLabelText(/address/i), '9 Mill Lane, Leeds{Enter}')

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()

    finish({ status: 201, body: {} })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('holds the confirmation while the removal is being sent', async () => {
    let finish
    const { user } = await renderPage({
      [`DELETE ${API}/buildings/b-2`]: () => new Promise((resolve) => (finish = resolve)),
    })
    await user.click(screen.getByRole('button', { name: 'Remove Riverside Annex' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))

    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()

    finish({ status: 204 })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('changes a floor\'s number, starting from the one it has', async () => {
    const { calls, user } = await renderPage({
      [`PATCH ${API}/floors/f-2`]: ({ body }) => {
        const floors = buildings[0].floors.map((floor) => (floor.id === 'f-2' ? { ...floor, ...body } : floor))
        buildings = [{ ...buildings[0], floors }, buildings[1]]
        return { body: { floor: { id: 'f-2', building_id: 'b-1', level: body.level } } }
      },
    })
    await user.click(within(headquarters()).getByRole('button', { name: 'Change Floor 2' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Change Floor 2 of Headquarters' }))
    expect(dialog.getByLabelText(/floor number/i)).toHaveValue(2)
    await user.clear(dialog.getByLabelText(/floor number/i))
    await user.type(dialog.getByLabelText(/floor number/i), '3{Enter}')

    expect(await within(headquarters()).findByRole('group', { name: 'Floor 3' })).toBeInTheDocument()
    expect(within(headquarters()).queryByRole('group', { name: 'Floor 2' })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(writes(calls)).toEqual([{ method: 'PATCH', path: `${API}/floors/f-2`, token: undefined, body: { level: 3 } }])
  })

  it('checks a changed floor number first, and shows the API\'s complaint under the field', async () => {
    const taken = 'This building already has that floor'
    const { calls, user } = await renderPage({
      [`PATCH ${API}/floors/f-2`]: () => apiError(409, 'conflict', taken, { level: taken }),
    })
    await user.click(within(headquarters()).getByRole('button', { name: 'Change Floor 2' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.clear(dialog.getByLabelText(/floor number/i))
    await user.type(dialog.getByLabelText(/floor number/i), '201{Enter}')
    expect(dialog.getByText('Floor must be between -5 and 200')).toBeInTheDocument()
    expect(writes(calls)).toEqual([])

    await user.clear(dialog.getByLabelText(/floor number/i))
    await user.type(dialog.getByLabelText(/floor number/i), '0{Enter}')
    expect(await dialog.findByText(taken)).toBeInTheDocument()
    expect(dialog.queryByRole('alert')).not.toBeInTheDocument() // under the field, not in a banner
    expect(dialog.getByLabelText(/floor number/i)).toHaveValue(0)

    await user.click(dialog.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(within(headquarters()).getByRole('group', { name: 'Floor 2' })).toBeInTheDocument() // unchanged
  })

  it('changes a seat\'s code from its chip, while its cross still removes it', async () => {
    const { calls, user } = await renderPage({
      [`PATCH ${API}/seats/s-1`]: ({ body }) => {
        const floors = buildings[0].floors.map((floor) => ({ ...floor, seats: floor.seats.map((seat) => ({ ...seat, ...body })) }))
        buildings = [{ ...buildings[0], floors }, buildings[1]]
        return { body: { seat: { id: 's-1', floor_id: 'f-0', code: body.code } } }
      },
    })
    await user.click(screen.getByRole('img', { name: 'Remove seat GF-A01' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1) // only the confirmation: the cross is not the chip
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Change seat GF-A01' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Change seat GF-A01' }))
    expect(dialog.getByLabelText(/seat code/i)).toHaveValue('GF-A01')
    await user.clear(dialog.getByLabelText(/seat code/i))
    await user.type(dialog.getByLabelText(/seat code/i), ' GF-B02 ')
    await user.click(dialog.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('button', { name: 'Change seat GF-B02' })).toBeInTheDocument()
    expect(screen.queryByText('GF-A01')).not.toBeInTheDocument()
    expect(writes(calls)).toEqual([{ method: 'PATCH', path: `${API}/seats/s-1`, token: undefined, body: { code: 'GF-B02' } }])
  })

  it('shows a problem with a changed seat code in its dialog: missing, a duplicate, or a failure', async () => {
    const taken = 'This floor already has a seat with that code'
    const answers = [apiError(409, 'conflict', taken, { code: taken }), apiError(404, 'not_found', 'Seat not found')]
    const { calls, user } = await renderPage({ [`PATCH ${API}/seats/s-1`]: () => answers.shift() })
    await user.click(screen.getByRole('button', { name: 'Change seat GF-A01' }))
    const dialog = within(screen.getByRole('dialog'))
    await user.clear(dialog.getByLabelText(/seat code/i))
    await user.click(dialog.getByRole('button', { name: 'Save' }))
    expect(dialog.getByText('Seat code is required')).toBeInTheDocument()
    expect(writes(calls)).toEqual([])

    await user.type(dialog.getByLabelText(/seat code/i), 'GF-A02{Enter}')
    expect(await dialog.findByText(taken)).toBeInTheDocument()
    expect(dialog.queryByRole('alert')).not.toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Save' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('Seat not found') // someone else removed it
    expect(dialog.getByLabelText(/seat code/i)).toHaveValue('GF-A02')
  })

  it('holds the change dialog while it is being saved', async () => {
    let finish
    const { calls, user } = await renderPage({
      [`PATCH ${API}/seats/s-1`]: () => new Promise((resolve) => (finish = resolve)),
    })
    await user.click(screen.getByRole('button', { name: 'Change seat GF-A01' }))
    await user.type(screen.getByRole('dialog').querySelector('input'), '{Enter}')

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }) // Escape must not close it either
    expect(writes(calls)).toHaveLength(1)

    finish({ body: { seat: { id: 's-1', floor_id: 'f-0', code: 'GF-A01' } } })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
