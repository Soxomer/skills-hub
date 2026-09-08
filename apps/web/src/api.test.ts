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
        body: '{}',
        headers: expect.objectContaining({
          'content-type': 'application/json',
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

  it('sends project scan and Default capture payloads as JSON', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jobId: 'scan_01' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            projectId: 'project_01',
            created: true,
            defaultRevision: {
              setupId: 'setup_01',
              setupRevisionId: 'revision_01',
              revisionNumber: 1,
              sourceScanJobId: 'scan_01',
              itemCount: 1,
              createdAt: '2026-09-01T10:00:00.000Z',
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      )

    await client(request).scanProject('instance with spaces')
    await client(request).captureDefault('project_01', {
      scanJobId: 'scan_01',
      includedDiscoveryIds: ['discovery_01'],
    })

    expect(request).toHaveBeenNthCalledWith(
      1,
      'https://hub.example.test/api/v1/project-instances/instance%20with%20spaces/scan',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ includeUnmanaged: true }),
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
      }),
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      'https://hub.example.test/api/v1/projects/project_01/default-revisions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          scanJobId: 'scan_01',
          includedDiscoveryIds: ['discovery_01'],
        }),
      }),
    )
  })

  it('preserves structured control-plane error codes', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ code: 'defaultAlreadyCaptured', error: 'already captured' }),
        { status: 409 },
      ),
    )

    await expect(
      client(request).captureDefault('project_01', {
        scanJobId: 'scan_02',
        includedDiscoveryIds: [],
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ControlPlaneApiError>>({
        status: 409,
        code: 'defaultAlreadyCaptured',
      }),
    )
  })

  it('loads composer items and publishes an exact Setup selection', async () => {
    const composer = {
      items: [
        {
          sourceSetupRevisionId: 'revision_default',
          sourceSetupName: 'Default / Project',
          artifactId: 'artifact_pdf',
          artifactKind: 'skill' as const,
          portableSource: 'github:openai/skills/pdf@v1',
          contentDigest: 'sha256:pdf',
          toolId: 'codex',
          targetName: 'pdf',
        },
      ],
    }
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(composer), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            setupId: 'setup_01',
            setupRevisionId: 'revision_01',
            name: 'Team essentials',
            kind: 'custom',
            revisionNumber: 1,
            itemCount: 1,
            createdAt: '2026-09-08T12:00:00.000Z',
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      )
    const api = client(request)

    await expect(api.setupComposer()).resolves.toEqual(composer)
    await api.createSetup({
      name: 'Team essentials',
      items: [
        {
          sourceSetupRevisionId: 'revision_default',
          artifactId: 'artifact_pdf',
          contentDigest: 'sha256:pdf',
          toolId: 'codex',
          targetName: 'pdf',
        },
      ],
    })

    expect(request).toHaveBeenNthCalledWith(
      1,
      'https://hub.example.test/api/v1/setups/composer',
      expect.objectContaining({ headers: expect.objectContaining({ accept: 'application/json' }) }),
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      'https://hub.example.test/api/v1/setups',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Team essentials',
          items: [
            {
              sourceSetupRevisionId: 'revision_default',
              artifactId: 'artifact_pdf',
              contentDigest: 'sha256:pdf',
              toolId: 'codex',
              targetName: 'pdf',
            },
          ],
        }),
      }),
    )
  })

  it('cancels a job and accepts an empty response', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))

    await expect(client(request).cancelJob('job with spaces')).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith(
      'https://hub.example.test/api/v1/jobs/job%20with%20spaces/cancel',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
      }),
    )
  })

  it('preserves the active operation returned by a single-flight conflict', async () => {
    const activeOperation = {
      jobId: 'job_02',
      kind: 'applyPlan' as const,
      state: 'acknowledged' as const,
      setupRevisionId: 'revision_02',
      cancelRequested: false,
      issuedAt: '2026-09-07T12:00:00.000Z',
    }
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 'projectOperationInProgress',
          error: 'another Setup operation is already in progress',
          activeOperation,
        }),
        { status: 409 },
      ),
    )

    await expect(
      client(request).prepareSetupPlan('instance_01', { setupRevisionId: 'revision_03' }),
    ).rejects.toEqual(expect.objectContaining({ activeOperation }))
  })
})
