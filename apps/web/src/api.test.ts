import { describe, expect, it, vi } from 'vitest'

import { ControlPlaneApiError, ControlPlaneClient } from './api'

function client(request: typeof fetch) {
  return new ControlPlaneClient({
    baseUrl: 'https://hub.example.test/',
    actor: { organizationId: 'org_01', userId: 'user_01' },
    fetch: request,
  })
}

describe('ControlPlaneClient', () => {
  it('sends actor context and parses runner enrollment responses', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          enrollmentId: 'enrollment_01',
          code: 'secret',
          expiresAt: '2026-09-01T10:10:00.000Z',
          command: 'ahm connect secret --server https://hub.example.test',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    const result = await client(request).createRunnerEnrollment()

    expect(result.enrollmentId).toBe('enrollment_01')
    expect(request).toHaveBeenCalledWith(
      'https://hub.example.test/api/v1/runner-enrollments',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-ahm-organization-id': 'org_01',
          'x-ahm-user-id': 'user_01',
        }),
      }),
    )
  })

  it('encodes identifiers and exposes a stable HTTP error', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'runner not found' }), { status: 404 }),
      )

    const action = client(request).runner('runner with spaces')

    await expect(action).rejects.toEqual(
      expect.objectContaining<Partial<ControlPlaneApiError>>({
        name: 'ControlPlaneApiError',
        status: 404,
        message: 'runner not found',
      }),
    )
    expect(request).toHaveBeenCalledWith(
      'https://hub.example.test/api/v1/runners/runner%20with%20spaces',
      expect.any(Object),
    )
  })
})
