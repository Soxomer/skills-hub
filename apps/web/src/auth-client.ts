import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient({
  ...(import.meta.env.VITE_AHM_API_BASE_URL ? { baseURL: import.meta.env.VITE_AHM_API_BASE_URL } : {}),
})
