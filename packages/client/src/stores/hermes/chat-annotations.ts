import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  appendResponseAnnotation,
  createResponseAnnotationDisplayEnvelope,
  MAX_RESPONSE_ANNOTATION_FILES,
  parseResponseAnnotationDisplayEnvelope,
  validateResponseAnnotations,
  type AppendResponseAnnotationError,
  type ResponseAnnotation,
} from '@/utils/chat-response-annotations'

const DRAFT_STORAGE_KEY = 'hermes_chat_response_annotation_drafts_v1'

type DraftMap = Record<string, ResponseAnnotation[]>

export interface ResponseAnnotationAnchorRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface ActiveResponseAnnotationEditor {
  sessionId: string
  annotationId: string
  anchor: ResponseAnnotationAnchorRect | null
}

function cloneAnnotations(annotations: readonly ResponseAnnotation[]): ResponseAnnotation[] {
  return annotations.map((annotation, index) => ({
    ...annotation,
    ordinal: index + 1,
    files: annotation.files.map(file => ({ ...file })),
  }))
}

function readPersistedDrafts(): DraftMap {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const drafts: DraftMap = {}
    for (const [sessionId, value] of Object.entries(parsed)) {
      const envelope = parseResponseAnnotationDisplayEnvelope(JSON.stringify({
        __hermes_studio_response_annotations__: 1,
        body: '',
        annotations: value,
      }))
      if (envelope) drafts[sessionId] = envelope.annotations
    }
    return drafts
  } catch {
    return {}
  }
}

export const useChatAnnotationsStore = defineStore('chat-annotations', () => {
  const annotationsBySession = ref<DraftMap>({})
  const hydratedSessions = ref(new Set<string>())
  const persistedDraftsLoaded = ref(false)
  const inspectedSentSessionId = ref<string | null>(null)
  const inspectedSentMessageId = ref<string | null>(null)
  const inspectedSentAnnotationsState = ref<ResponseAnnotation[]>([])
  const activeEditor = ref<ActiveResponseAnnotationEditor | null>(null)
  const pendingFilesByAnnotationId = ref<Record<string, File[]>>({})

  const inspectedSentAnnotations = computed(() => inspectedSentAnnotationsState.value)

  function persist() {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(annotationsBySession.value))
  }

  function hydrateSession(sessionId: string) {
    if (!sessionId || hydratedSessions.value.has(sessionId)) return
    if (!persistedDraftsLoaded.value) {
      const persisted = readPersistedDrafts()
      annotationsBySession.value = Object.fromEntries(
        Object.entries(persisted).map(([persistedSessionId, annotations]) => [
          persistedSessionId,
          cloneAnnotations(annotations),
        ]),
      )
      hydratedSessions.value = new Set(Object.keys(persisted))
      persistedDraftsLoaded.value = true
    }
    hydratedSessions.value = new Set(hydratedSessions.value).add(sessionId)
  }

  function annotationsForSession(sessionId: string): ResponseAnnotation[] {
    hydrateSession(sessionId)
    return annotationsBySession.value[sessionId] || []
  }

  function setSessionAnnotations(sessionId: string, annotations: readonly ResponseAnnotation[]) {
    const normalized = cloneAnnotations(annotations)
    if (normalized.length === 0) delete annotationsBySession.value[sessionId]
    else annotationsBySession.value[sessionId] = normalized
    persist()
  }

  function addAnnotation(
    sessionId: string,
    annotation: ResponseAnnotation,
  ): AppendResponseAnnotationError | null {
    const result = appendResponseAnnotation(annotationsForSession(sessionId), annotation)
    if (!result.error) setSessionAnnotations(sessionId, result.annotations)
    return result.error
  }

  function updateAnnotation(
    sessionId: string,
    annotationId: string,
    changes: Partial<Pick<ResponseAnnotation, 'comment' | 'files'>>,
  ): AppendResponseAnnotationError | 'missing' | null {
    const current = annotationsForSession(sessionId)
    if (!current.some(annotation => annotation.id === annotationId)) return 'missing'
    const next = current.map(annotation => annotation.id === annotationId
      ? {
          ...annotation,
          ...changes,
          files: changes.files ? changes.files.map(file => ({ ...file })) : annotation.files,
        }
      : annotation)
    const error = validateResponseAnnotations(next)
    if (error) return error
    setSessionAnnotations(sessionId, next)
    return null
  }

  function removeAnnotation(sessionId: string, annotationId: string) {
    setSessionAnnotations(
      sessionId,
      annotationsForSession(sessionId).filter(annotation => annotation.id !== annotationId),
    )
    if (pendingFilesByAnnotationId.value[annotationId]) {
      const next = { ...pendingFilesByAnnotationId.value }
      delete next[annotationId]
      pendingFilesByAnnotationId.value = next
    }
    if (activeEditor.value?.annotationId === annotationId) closeEditor()
  }

  function clearAnnotations(sessionId: string) {
    const annotationIds = annotationsForSession(sessionId).map(annotation => annotation.id)
    setSessionAnnotations(sessionId, [])
    if (annotationIds.length > 0) {
      const next = { ...pendingFilesByAnnotationId.value }
      for (const annotationId of annotationIds) delete next[annotationId]
      pendingFilesByAnnotationId.value = next
    }
    if (activeEditor.value?.sessionId === sessionId) closeEditor()
  }

  function inspectSentAnnotations(
    sessionId: string,
    messageId: string,
    annotations: readonly ResponseAnnotation[],
  ) {
    inspectedSentSessionId.value = sessionId
    inspectedSentMessageId.value = messageId
    inspectedSentAnnotationsState.value = cloneAnnotations(annotations)
  }

  function clearInspectedSentAnnotations(messageId?: string) {
    if (messageId && inspectedSentMessageId.value !== messageId) return
    inspectedSentSessionId.value = null
    inspectedSentMessageId.value = null
    inspectedSentAnnotationsState.value = []
  }

  function openEditor(
    sessionId: string,
    annotationId: string,
    anchor: ResponseAnnotationAnchorRect | null = null,
  ) {
    if (!annotationsForSession(sessionId).some(annotation => annotation.id === annotationId)) return
    activeEditor.value = { sessionId, annotationId, anchor }
  }

  function closeEditor() {
    activeEditor.value = null
  }

  function pendingFilesForAnnotation(annotationId: string): File[] {
    return pendingFilesByAnnotationId.value[annotationId] || []
  }

  function addPendingFiles(
    sessionId: string,
    annotationId: string,
    files: File[],
  ): AppendResponseAnnotationError | 'missing' | null {
    if (!annotationsForSession(sessionId).some(annotation => annotation.id === annotationId)) return 'missing'
    const total = annotationsForSession(sessionId).reduce(
      (count, annotation) => count + annotation.files.length + pendingFilesForAnnotation(annotation.id).length,
      0,
    )
    if (total + files.length > MAX_RESPONSE_ANNOTATION_FILES) return 'too_many_files'
    pendingFilesByAnnotationId.value = {
      ...pendingFilesByAnnotationId.value,
      [annotationId]: [...pendingFilesForAnnotation(annotationId), ...files],
    }
    return null
  }

  function removePendingFile(annotationId: string, fileIndex: number) {
    const remaining = pendingFilesForAnnotation(annotationId).filter((_, index) => index !== fileIndex)
    const next = { ...pendingFilesByAnnotationId.value }
    if (remaining.length > 0) next[annotationId] = remaining
    else delete next[annotationId]
    pendingFilesByAnnotationId.value = next
  }

  function replacePendingFiles(annotationId: string, files: File[]) {
    const next = { ...pendingFilesByAnnotationId.value }
    if (files.length > 0) next[annotationId] = [...files]
    else delete next[annotationId]
    pendingFilesByAnnotationId.value = next
  }

  function displayEnvelopeForSession(sessionId: string, body: string): string | null {
    const annotations = annotationsForSession(sessionId)
    return annotations.length > 0
      ? createResponseAnnotationDisplayEnvelope(body, annotations)
      : null
  }

  return {
    annotationsBySession,
    inspectedSentSessionId,
    inspectedSentMessageId,
    inspectedSentAnnotations,
    activeEditor,
    pendingFilesByAnnotationId,
    hydrateSession,
    annotationsForSession,
    addAnnotation,
    updateAnnotation,
    removeAnnotation,
    clearAnnotations,
    inspectSentAnnotations,
    clearInspectedSentAnnotations,
    openEditor,
    closeEditor,
    pendingFilesForAnnotation,
    addPendingFiles,
    removePendingFile,
    replacePendingFiles,
    displayEnvelopeForSession,
  }
})
