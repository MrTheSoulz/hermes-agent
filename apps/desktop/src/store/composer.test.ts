import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  $composerAttachments,
  $composerNewChatGeneration,
  $voiceConversationStartRequest,
  addComposerAttachment,
  advanceComposerNewChatGeneration,
  claimSessionDraft,
  clearSessionDraft,
  clearSessionDraftIfMatches,
  clearSessionDraftIfRevision,
  type ComposerAttachment,
  createComposerAttachmentOccurrenceId,
  createComposerAttachmentScope,
  migrateSessionDraft,
  reloadPersistedDrafts,
  removeComposerAttachment,
  requestVoiceConversationStart,
  SESSION_DRAFTS_STORAGE_KEY,
  sessionDraftRevision,
  stashSessionDraft,
  takeSessionDraft,
  takeVoiceConversationStart,
  updateComposerAttachment
} from './composer'
import { encodeComposerStorageScopeKey } from './composer-storage-scope'

describe('New Chat storage identities', () => {
  afterEach(() => $composerNewChatGeneration.set(0))

  it('allocates distinct identities from the same stale cross-window snapshot', () => {
    $composerNewChatGeneration.set(12)
    const first = advanceComposerNewChatGeneration()

    $composerNewChatGeneration.set(12)
    const second = advanceComposerNewChatGeneration()

    expect(first).not.toBe(second)
  })
})

describe('voice conversation start requests', () => {
  it('latches each request until the main composer consumes it once', () => {
    requestVoiceConversationStart()
    const first = $voiceConversationStartRequest.get()

    expect(takeVoiceConversationStart(first)).toBe(true)
    expect(takeVoiceConversationStart(first)).toBe(false)

    requestVoiceConversationStart()
    expect(takeVoiceConversationStart($voiceConversationStartRequest.get())).toBe(true)
  })
})

function attachment(overrides: Partial<ComposerAttachment> & Pick<ComposerAttachment, 'id'>): ComposerAttachment {
  return { kind: 'file', label: 'doc.pdf', ...overrides }
}

describe('updateComposerAttachment', () => {
  afterEach(() => {
    $composerAttachments.set([])
  })

  it('replaces an existing attachment in place', () => {
    addComposerAttachment(attachment({ id: 'file:a', uploadState: 'uploading' }))

    const updated = updateComposerAttachment(attachment({ id: 'file:a', attachedSessionId: 'sess-1' }))

    expect(updated).toBe(true)
    const current = $composerAttachments.get()
    expect(current).toHaveLength(1)
    expect(current[0]?.attachedSessionId).toBe('sess-1')
    expect(current[0]?.uploadState).toBeUndefined()
  })

  it('does NOT resurrect an attachment the user removed mid-upload', () => {
    // Drop → eager upload starts → user removes the chip → upload resolves.
    // The late success must not re-add the removed attachment.
    addComposerAttachment(attachment({ id: 'file:a', uploadState: 'uploading' }))
    removeComposerAttachment('file:a')

    const updated = updateComposerAttachment(attachment({ id: 'file:a', attachedSessionId: 'sess-1' }))

    expect(updated).toBe(false)
    expect($composerAttachments.get()).toHaveLength(0)
  })

  it('updates only the exact attachment occurrence captured before an async operation', () => {
    const scope = createComposerAttachmentScope()

    const first = attachment({
      id: 'image:a',
      kind: 'image',
      occurrenceId: createComposerAttachmentOccurrenceId(),
      path: '/tmp/a.png'
    })

    const replacement = attachment({
      id: 'image:a',
      kind: 'image',
      occurrenceId: createComposerAttachmentOccurrenceId(),
      path: '/tmp/a.png'
    })

    scope.add(first)
    scope.remove(first.id)
    scope.add(replacement)

    expect(scope.updateIfCurrent(first, { thumbnailUrl: 'data:image/png;base64,stale' })).toBe(false)
    expect(scope.$attachments.get()).toEqual([replacement])
    expect(scope.updateIfCurrent(replacement, { thumbnailUrl: 'data:image/png;base64,current' })).toBe(true)
    expect(scope.$attachments.get()[0]?.thumbnailUrl).toBe('data:image/png;base64,current')
  })

  it('recognizes the same attachment occurrence after a session-draft clone', () => {
    const scope = createComposerAttachmentScope()

    const original = attachment({
      id: 'image:draft',
      kind: 'image',
      occurrenceId: createComposerAttachmentOccurrenceId(),
      path: '/tmp/draft.png'
    })

    stashSessionDraft('session-a', '', [original])
    const restored = takeSessionDraft('session-a').attachments[0]!
    scope.add(restored)

    expect(restored).not.toBe(original)
    expect(scope.updateIfCurrent(original, { thumbnailUrl: 'data:image/png;base64,current' })).toBe(true)
    expect(scope.$attachments.get()[0]?.thumbnailUrl).toBe('data:image/png;base64,current')
    clearSessionDraft('session-a')
  })

  it('merges concurrent staging fields without discarding an existing thumbnail', () => {
    const scope = createComposerAttachmentScope()

    const original = attachment({
      id: 'image:staging',
      kind: 'image',
      occurrenceId: createComposerAttachmentOccurrenceId(),
      path: 'C:\\Users\\alice\\Pictures\\photo.png'
    })

    scope.add(original)
    expect(scope.updateIfCurrent(original, { thumbnailUrl: 'data:image/png;base64,current' })).toBe(true)
    expect(
      scope.updateIfCurrent(original, {
        attachedSessionId: 'session-1',
        path: '/root/.hermes/attachments/photo.png',
        uploadState: undefined
      })
    ).toBe(true)

    expect(scope.$attachments.get()[0]).toMatchObject({
      attachedSessionId: 'session-1',
      path: '/root/.hermes/attachments/photo.png',
      thumbnailUrl: 'data:image/png;base64,current'
    })
  })

  it('removes submitted occurrences while preserving unrelated attachments', () => {
    const scope = createComposerAttachmentScope()

    const submitted = attachment({
      id: 'image:submitted',
      kind: 'image',
      occurrenceId: 'occurrence-submitted'
    })

    const other = attachment({ id: 'file:other', occurrenceId: 'occurrence-other' })

    scope.add(submitted)
    scope.add(other)
    scope.removeOccurrences([submitted])

    expect(scope.$attachments.get()).toEqual([other])
  })

  it('preserves a same-id replacement of a submitted occurrence', () => {
    const scope = createComposerAttachmentScope()

    const submitted = attachment({
      id: 'image:submitted',
      kind: 'image',
      occurrenceId: 'occurrence-submitted'
    })

    const replacement = attachment({
      ...submitted,
      occurrenceId: 'occurrence-replacement'
    })

    scope.add(replacement)
    scope.removeOccurrences([submitted])

    expect(scope.$attachments.get()).toEqual([replacement])
  })

  it('preserves a newer same-id legacy attachment and still emits on successful cleanup', () => {
    const scope = createComposerAttachmentScope()
    const submitted = attachment({ id: 'url:https://example.com', kind: 'url', label: 'old' })
    const replacement = attachment({ id: submitted.id, kind: 'url', label: 'new' })
    const listener = vi.fn()
    const unlisten = scope.$attachments.listen(listener)

    scope.add(submitted)
    scope.remove(submitted.id)
    scope.add(replacement)
    listener.mockClear()

    scope.removeOccurrences([submitted])

    expect(scope.$attachments.get()).toEqual([replacement])
    expect(listener).toHaveBeenCalledTimes(1)
    unlisten()
  })

  it('removes the exact submitted legacy attachment', () => {
    const scope = createComposerAttachmentScope()
    const submitted = attachment({ id: 'url:https://example.com', kind: 'url' })

    scope.add(submitted)
    scope.removeOccurrences([submitted])

    expect(scope.$attachments.get()).toEqual([])
  })
})

describe('session drafts', () => {
  const ownerA = { connectionId: 'source-a', profile: 'profile-a' }
  const ownerB = { connectionId: 'source-b', profile: 'profile-a' }
  const ownerAScope = encodeComposerStorageScopeKey(ownerA, 'shared-session')
  const ownerBScope = encodeComposerStorageScopeKey(ownerB, 'shared-session')

  afterEach(() => {
    for (const scope of ['session-a', 'session-b', ownerAScope, ownerBScope, 'stored-legacy', null]) {
      clearSessionDraft(scope)
    }

    window.localStorage.clear()
  })

  it('keeps drafts isolated per session scope', () => {
    stashSessionDraft('session-a', 'draft a', [])
    stashSessionDraft('session-b', 'draft b', [attachment({ id: 'image:b', kind: 'image' })])

    expect(takeSessionDraft('session-a')).toEqual({ attachments: [], text: 'draft a' })
    expect(takeSessionDraft('session-b').text).toBe('draft b')
    expect(takeSessionDraft('session-b').attachments.map(a => a.id)).toEqual(['image:b'])
  })

  it('scopes the unsaved new-session draft separately from real sessions', () => {
    stashSessionDraft(null, 'new chat draft', [])
    stashSessionDraft('session-a', 'session draft', [])

    expect(takeSessionDraft(null).text).toBe('new chat draft')
    expect(takeSessionDraft(undefined).text).toBe('new chat draft')
    expect(takeSessionDraft('session-a').text).toBe('session draft')
  })

  it('persists draft text (not attachments) to localStorage', () => {
    stashSessionDraft('session-a', 'survives reload', [attachment({ id: 'file:a' })])

    const persisted = JSON.parse(window.localStorage.getItem(SESSION_DRAFTS_STORAGE_KEY) ?? '{}') as Record<
      string,
      string
    >

    expect(persisted['session-a']).toBe('survives reload')
  })

  it('persists duplicate stored ids under exact-owner keys', () => {
    stashSessionDraft(ownerAScope, 'owner A', [])
    stashSessionDraft(ownerBScope, 'owner B', [])

    const persisted = JSON.parse(window.localStorage.getItem(SESSION_DRAFTS_STORAGE_KEY) ?? '{}') as Record<
      string,
      string
    >

    expect(persisted).toMatchObject({ [ownerAScope]: 'owner A', [ownerBScope]: 'owner B' })
    expect(takeSessionDraft(ownerAScope).text).toBe('owner A')
    expect(takeSessionDraft(ownerBScope).text).toBe('owner B')
  })

  it('advances the revision when another window replaces a persisted draft', () => {
    stashSessionDraft('session-a', 'submitted text', [])
    const submittedRevision = sessionDraftRevision('session-a')

    window.localStorage.setItem(SESSION_DRAFTS_STORAGE_KEY, JSON.stringify({ 'session-a': 'newer other-window draft' }))
    reloadPersistedDrafts()

    expect(sessionDraftRevision('session-a')).toBeGreaterThan(submittedRevision)
    expect(clearSessionDraftIfRevision('session-a', submittedRevision)).toBe(false)
    expect(takeSessionDraft('session-a').text).toBe('newer other-window draft')
  })

  it('does not erase a newer persisted draft when dispatch clears a stale renderer snapshot', () => {
    stashSessionDraft('session-a', 'submitted text', [])
    window.localStorage.setItem(SESSION_DRAFTS_STORAGE_KEY, JSON.stringify({ 'session-a': 'newer other-window draft' }))

    expect(clearSessionDraftIfMatches('session-a', 'submitted text', [])).toBeNull()
    expect(takeSessionDraft('session-a').text).toBe('newer other-window draft')
  })

  it('preserves attachment-only inactive drafts when another window updates persisted text', () => {
    stashSessionDraft('session-a', '', [attachment({ id: 'image:a', kind: 'image' })])
    window.localStorage.setItem(SESSION_DRAFTS_STORAGE_KEY, JSON.stringify({ 'session-b': 'other window text' }))

    reloadPersistedDrafts()

    expect(takeSessionDraft('session-a').attachments.map(item => item.id)).toEqual(['image:a'])
    expect(takeSessionDraft('session-b').text).toBe('other window text')
  })

  it('evicts empty drafts instead of leaving stale entries behind', () => {
    stashSessionDraft('session-a', 'saved', [])
    stashSessionDraft('session-a', '   ', [])

    expect(takeSessionDraft('session-a')).toEqual({ attachments: [], text: '' })
  })

  it('clears a stashed draft after an accepted submit', () => {
    stashSessionDraft('session-a', 'sent prompt', [attachment({ id: 'file:a' })])
    clearSessionDraft('session-a')

    expect(takeSessionDraft('session-a')).toEqual({ attachments: [], text: '' })
  })

  it('returns clones so callers cannot mutate the stash', () => {
    stashSessionDraft('session-a', 'draft', [attachment({ id: 'file:a' })])

    const taken = takeSessionDraft('session-a')
    taken.attachments[0]!.label = 'mutated'

    expect(takeSessionDraft('session-a').attachments[0]?.label).toBe('doc.pdf')
  })

  it('migrates a tip-keyed draft onto the post-compression tip', () => {
    const tipBefore = '20260720_062637_ad96b3'
    const tipAfter = '20260720_071049_a28905'

    stashSessionDraft(tipBefore, 'half typed while thinking', [])

    expect(migrateSessionDraft(tipBefore, tipAfter)).toBe(true)
    expect(takeSessionDraft(tipAfter).text).toBe('half typed while thinking')
    expect(takeSessionDraft(tipBefore).text).toBe('')

    clearSessionDraft(tipAfter)
  })

  it('does not overwrite a non-empty destination draft during migration', () => {
    stashSessionDraft('from', 'old tip draft', [])
    stashSessionDraft('to', 'already typed on new tip', [])

    expect(migrateSessionDraft('from', 'to')).toBe(false)
    expect(takeSessionDraft('to').text).toBe('already typed on new tip')
    expect(takeSessionDraft('from').text).toBe('old tip draft')

    clearSessionDraft('from')
    clearSessionDraft('to')
  })

  it('migrates the legacy New Chat draft into an exact-owner scope', () => {
    const qualified = encodeComposerStorageScopeKey(ownerA, null, 7)
    stashSessionDraft(null, 'new chat before owner scoping', [])

    expect(migrateSessionDraft(null, qualified)).toBe(true)
    expect(takeSessionDraft(qualified).text).toBe('new chat before owner scoping')
    expect(takeSessionDraft(null).text).toBe('')

    clearSessionDraft(qualified)
  })

  it('claims a proven legacy draft once even when the destination is non-empty', () => {
    stashSessionDraft('stored-legacy', 'legacy unqualified draft', [])
    stashSessionDraft(ownerAScope, 'newer owner A draft', [])

    expect(claimSessionDraft('stored-legacy', ownerAScope)).toBe(true)
    expect(takeSessionDraft(ownerAScope).text).toBe('newer owner A draft')
    expect(takeSessionDraft('stored-legacy').text).toBe('')
    expect(claimSessionDraft('stored-legacy', ownerBScope)).toBe(false)
  })
})
