import { describe, expect, it } from 'vitest'
import { legacyPiDeliveryMessage, piOperationCurrent, piSubmitAllowed, releasePiOperation, resetPiSubmissionOnReconnect, uploadThenPrompt } from './piSubmission'

describe('Pi submission lifetime guards', () => {
  it('does not prompt when cancellation arrives while UploadFinish is delayed', async () => {
    const controller = new AbortController()
    let finishUpload!: (id: string) => void
    let prompted = false
    const upload = new Promise<string>((resolve) => { finishUpload = resolve })
    const operation = uploadThenPrompt(
      ['image.png'],
      async () => upload,
      async () => { prompted = true },
      () => piOperationCurrent(controller.signal, 4, 4, true),
    )

    controller.abort()
    finishUpload('attachment-1')

    await expect(operation).resolves.toBe(false)
    expect(prompted).toBe(false)
  })

  it('does not prompt on a replacement port/session after reconnect', async () => {
    let generation = 8
    let finishUpload!: (id: string) => void
    let prompted = false
    const upload = new Promise<string>((resolve) => { finishUpload = resolve })
    const controller = new AbortController()
    const operation = uploadThenPrompt(
      ['image.png'],
      async () => upload,
      async () => { prompted = true },
      () => piOperationCurrent(controller.signal, 8, generation, true),
    )

    generation = 9
    finishUpload('attachment-2')

    await expect(operation).resolves.toBe(false)
    expect(prompted).toBe(false)
  })

  it('rejects a same-tick duplicate attachment submit after the first claims ownership', () => {
    let owner: string | null = null
    expect(piSubmitAllowed(owner, true, false)).toBe(true)
    owner = 'upload-1'
    expect(piSubmitAllowed(owner, true, false)).toBe(false)
    expect(piSubmitAllowed(owner, true, false)).toBe(false)
  })

  it('allows only one receipt-backed submit until its receipt clears the guard', () => {
    expect(piSubmitAllowed(null, true, false)).toBe(true)
    expect(piSubmitAllowed('prompt-1', true, false)).toBe(false)
    expect(piSubmitAllowed(null, true, true)).toBe(false)
    expect(piSubmitAllowed(null, false, false)).toBe(false)
  })

  it('keeps legacy drafts because neither post result is a delivery receipt', () => {
    expect(legacyPiDeliveryMessage(true)).toContain('draft was kept')
    expect(legacyPiDeliveryMessage(false)).toContain('draft was kept')
  })

  it('reconnect cleanup resets the upload UI and releases the old owner', () => {
    expect(resetPiSubmissionOnReconnect()).toEqual({ pendingRequestId: null, uploading: false })
    expect(releasePiOperation('upload-old', 'upload-old')).toBeNull()
    expect(releasePiOperation('upload-new', 'upload-old')).toBe('upload-new')
  })
})
