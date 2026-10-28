import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { ErrorState } from './ui'
import { ApiError } from '@/lib/api'

describe('ErrorState', () => {
  it('never shows a bare "unauthorized": says the sign-in ended and offers sign in', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(<ErrorState error={new ApiError(401, 'unknown', 'unauthorized')} />))
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Your sign-in has ended. Sign in again to see this.')
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/login')
    act(() => root.unmount())
  })
})
