import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ShowMore from './ShowMore.jsx'

describe('ShowMore', () => {
  it('says how much of the list is on screen and offers the next page', async () => {
    const showMore = vi.fn()
    render(<ShowMore shown={20} total={137} pageSize={20} showMore={showMore} />)
    expect(screen.getByText('Showing 20 of 137')).toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Show 20 more' }))
    expect(showMore).toHaveBeenCalledTimes(1)
  })

  it('offers only what is left when the last page is a short one', () => {
    render(<ShowMore shown={40} total={45} pageSize={20} showMore={() => {}} />)
    expect(screen.getByRole('button', { name: 'Show 5 more' })).toBeInTheDocument()
  })

  it('draws nothing once everything is shown', () => {
    const { container } = render(<ShowMore shown={12} total={12} pageSize={20} showMore={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
