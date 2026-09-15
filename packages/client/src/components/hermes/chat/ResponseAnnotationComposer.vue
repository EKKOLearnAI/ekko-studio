<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatAnnotationsStore } from '@/stores/hermes/chat-annotations'
import { MAX_RESPONSE_ANNOTATION_COMMENT_LENGTH, type ResponseAnnotation } from '@/utils/chat-response-annotations'

const props = defineProps<{ sessionId: string }>()
const { t } = useI18n()
const annotationsStore = useChatAnnotationsStore()
const expanded = ref(false)
const previewVisible = ref(false)
const comment = ref('')
const editorFiles = ref<File[]>([])
const editorTextarea = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const validationError = ref('')
const viewportVersion = ref(0)

const annotations = computed(() => annotationsStore.annotationsForSession(props.sessionId) ?? [])
const previewAnnotations = computed(() => annotations.value.slice(0, 3))
const previewId = computed(() => `response-annotation-preview-${props.sessionId.replace(/[^a-z0-9_-]/gi, '-')}`)
const pendingFilesFor = (annotationId: string) => annotationsStore.pendingFilesForAnnotation(annotationId) ?? []
const activeEditor = computed(() => annotationsStore.activeEditor?.sessionId === props.sessionId
  ? annotationsStore.activeEditor
  : null)
const editorAnnotation = computed(() => activeEditor.value
  ? annotations.value.find(annotation => annotation.id === activeEditor.value?.annotationId) || null
  : null)
const editorStyle = computed(() => {
  viewportVersion.value
  const anchor = activeEditor.value?.anchor
  if (!anchor) return {
    left: '8px',
    bottom: '8px',
    maxHeight: `${Math.min(576, Math.max(0, window.innerHeight - 16))}px`,
  }
  const width = Math.min(352, window.innerWidth - 16)
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))
  const anchorTop = Math.max(8, Math.min(anchor.top, window.innerHeight - 8))
  const anchorBottom = Math.max(anchorTop, Math.max(8, Math.min(anchor.bottom, window.innerHeight - 8)))
  const availableAbove = Math.max(0, anchorTop - 16)
  const availableBelow = Math.max(0, window.innerHeight - anchorBottom - 16)
  if (availableAbove >= availableBelow) {
    return {
      left: `${left}px`,
      bottom: `${Math.max(8, window.innerHeight - anchorTop + 8)}px`,
      maxHeight: `${Math.min(576, availableAbove)}px`,
    }
  }
  const top = Math.max(8, anchorBottom + 8)
  return {
    left: `${left}px`,
    top: `${top}px`,
    maxHeight: `${Math.min(576, Math.max(0, window.innerHeight - top - 8))}px`,
  }
})

watch(
  () => editorAnnotation.value?.id,
  () => {
    const current = editorAnnotation.value
    if (!current) return
    comment.value = current.comment || ''
    editorFiles.value = [...pendingFilesFor(current.id)]
    validationError.value = ''
    expanded.value = false
    void nextTick(() => editorTextarea.value?.focus())
  },
  { immediate: true },
)

watch(() => props.sessionId, () => {
  expanded.value = false
  previewVisible.value = false
  annotationsStore.closeEditor()
})

function annotationCountLabel(count: number) {
  return t(count === 1 ? 'chat.annotations.countOne' : 'chat.annotations.countMany', { count })
}

function toggleExpanded() {
  expanded.value = !expanded.value
  previewVisible.value = false
  if (expanded.value) annotationsStore.closeEditor()
}

function showPreview() {
  if (!expanded.value) previewVisible.value = true
}

function hidePreview() {
  previewVisible.value = false
}

function handlePreviewFocusOut(event: FocusEvent) {
  const current = event.currentTarget as HTMLElement
  if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) return
  hidePreview()
}

function clearAll() {
  annotationsStore.clearAnnotations(props.sessionId)
  expanded.value = false
  previewVisible.value = false
}

function editAnnotation(annotation: ResponseAnnotation, event: MouseEvent) {
  const target = event.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  annotationsStore.openEditor(props.sessionId, annotation.id, {
    left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
  })
}

function deleteAnnotation(annotationId: string) {
  annotationsStore.removeAnnotation(props.sessionId, annotationId)
  if (annotations.value.length === 0) expanded.value = false
}

function chooseFiles() {
  fileInput.value?.click()
}

function handleFiles(event: Event) {
  const input = event.target as HTMLInputElement
  editorFiles.value = [...editorFiles.value, ...Array.from(input.files || [])]
  input.value = ''
}

function removeEditorFile(index: number) {
  editorFiles.value = editorFiles.value.filter((_, fileIndex) => fileIndex !== index)
}

function cancelEditor() {
  annotationsStore.closeEditor()
}

function saveEditor() {
  const current = editorAnnotation.value
  if (!current) return
  if (comment.value.length > MAX_RESPONSE_ANNOTATION_COMMENT_LENGTH) {
    validationError.value = t('chat.annotations.commentTooLong', { count: MAX_RESPONSE_ANNOTATION_COMMENT_LENGTH })
    return
  }
  const existingPersistedFiles = annotations.value.find(annotation => annotation.id === current.id)?.files.length || 0
  const otherFileCount = annotations.value.reduce((total, annotation) => (
    total
    + (annotation.id === current.id ? 0 : annotation.files.length + pendingFilesFor(annotation.id).length)
  ), 0)
  if (existingPersistedFiles + otherFileCount + editorFiles.value.length > 10) {
    validationError.value = t('chat.annotations.tooManyFiles', { count: 10 })
    return
  }
  const updateError = annotationsStore.updateAnnotation(props.sessionId, current.id, {
    comment: comment.value.trim() || null,
  })
  if (updateError) {
    validationError.value = t(`chat.annotations.errors.${updateError}`)
    return
  }
  annotationsStore.replacePendingFiles(current.id, editorFiles.value)
  annotationsStore.closeEditor()
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  if (activeEditor.value) {
    event.preventDefault()
    cancelEditor()
  } else if (expanded.value) {
    event.preventDefault()
    expanded.value = false
  }
}

document.addEventListener('keydown', handleDocumentKeydown)
onMounted(() => window.addEventListener('resize', handleViewportResize))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleDocumentKeydown)
  window.removeEventListener('resize', handleViewportResize)
})

function handleViewportResize() {
  viewportVersion.value += 1
}
</script>

<template>
  <div
    v-if="annotations.length > 0"
    class="response-annotation-composer"
    data-annotation-ignore
    @mouseenter="showPreview"
    @mouseleave="hidePreview"
    @focusin="showPreview"
    @focusout="handlePreviewFocusOut"
  >
    <div class="response-annotation-chip">
      <button
        type="button"
        data-testid="response-annotation-count"
        :aria-expanded="expanded"
        :aria-describedby="previewVisible && !expanded ? previewId : undefined"
        @click="toggleExpanded"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
        </svg>
        <span>{{ annotationCountLabel(annotations.length) }}</span>
        <svg class="annotation-chevron" :class="{ expanded }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <button type="button" class="response-annotation-clear" :aria-label="t('chat.annotations.clearAll')" @click="clearAll">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>

    <div
      v-if="previewVisible && !expanded"
      :id="previewId"
      role="tooltip"
      class="response-annotation-preview"
      data-testid="response-annotation-preview"
    >
      <ol>
        <li v-for="annotation in previewAnnotations" :key="annotation.id">
          <p class="annotation-label">{{ annotation.ordinal }}. {{ t('chat.annotations.selectedExcerpt') }}</p>
          <blockquote>{{ annotation.selectedText }}</blockquote>
          <template v-if="annotation.comment">
            <p class="annotation-label annotation-preview-comment-label">{{ t('chat.annotations.yourComment') }}</p>
            <p class="annotation-comment">{{ annotation.comment }}</p>
          </template>
        </li>
      </ol>
    </div>

    <div v-if="expanded" class="response-annotation-card" data-testid="response-annotation-draft-card">
      <ol>
        <li v-for="annotation in annotations" :key="annotation.id">
          <div class="annotation-row-actions">
            <button type="button" :aria-label="t('chat.annotations.editLabel', { index: annotation.ordinal })" @click="editAnnotation(annotation, $event)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>
            </button>
            <button type="button" :aria-label="t('chat.annotations.deleteLabel', { index: annotation.ordinal })" @click="deleteAnnotation(annotation.id)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
            </button>
          </div>
          <p class="annotation-label">{{ annotation.ordinal }}. {{ t('chat.annotations.selectedExcerpt') }}</p>
          <blockquote>{{ annotation.selectedText }}</blockquote>
          <template v-if="annotation.comment">
            <div class="annotation-divider" />
            <p class="annotation-label">{{ t('chat.annotations.yourComment') }}</p>
            <p class="annotation-comment">{{ annotation.comment }}</p>
          </template>
          <div v-if="annotation.files.length || pendingFilesFor(annotation.id).length" class="annotation-files">
            <span v-for="file in annotation.files" :key="file.id">📎 {{ file.name }}</span>
            <span v-for="(file, index) in pendingFilesFor(annotation.id)" :key="`${file.name}-${index}`">📎 {{ file.name }}</span>
          </div>
        </li>
      </ol>
    </div>
  </div>

  <Teleport to="body">
    <section
      v-if="editorAnnotation"
      class="response-annotation-editor"
      data-testid="response-annotation-editor"
      :style="editorStyle"
      :aria-label="`Edit annotation ${editorAnnotation.ordinal}`"
      data-annotation-ignore
    >
      <textarea
        ref="editorTextarea"
        v-model="comment"
        :placeholder="t('chat.annotations.optionalComment')"
        :aria-label="t('chat.annotations.comment')"
        :maxlength="MAX_RESPONSE_ANNOTATION_COMMENT_LENGTH"
      />
      <div v-if="editorFiles.length" class="editor-files">
        <span v-for="(file, index) in editorFiles" :key="`${file.name}-${index}`">
          {{ file.name }}
          <button type="button" :aria-label="t('chat.annotations.removeFile', { name: file.name })" @click="removeEditorFile(index)">×</button>
        </span>
      </div>
      <p v-if="validationError" role="alert" class="editor-error">{{ validationError }}</p>
      <div class="editor-actions">
        <input ref="fileInput" type="file" multiple hidden @change="handleFiles" />
        <button type="button" class="editor-icon" :aria-label="t('chat.annotations.addFiles')" :title="t('chat.annotations.addFiles')" @click="chooseFiles">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m21.4 11.6-8.5 8.5a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>
        </button>
        <button type="button" class="editor-icon editor-delete" :aria-label="t('chat.annotations.delete')" @click="deleteAnnotation(editorAnnotation.id)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
        </button>
        <button type="button" @click="cancelEditor">{{ t('chat.annotations.cancel') }}</button>
        <button type="button" class="editor-save" @click="saveEditor">{{ t('chat.annotations.save') }}</button>
      </div>
    </section>
  </Teleport>
</template>

<style scoped lang="scss">
.response-annotation-composer {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: flex-start;
  margin-bottom: 8px;
}

.response-annotation-chip {
  display: inline-flex;
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--bg-card-hover);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.16);
}

.response-annotation-chip button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
  padding: 0 11px;
  border: 0;
  color: var(--text-secondary);
  background: transparent;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.response-annotation-chip button:hover,
.response-annotation-chip button:focus-visible {
  color: var(--text-primary);
  background: var(--bg-card);
  outline: none;
}

.response-annotation-clear {
  border-inline-start: 1px solid var(--border-color) !important;
  padding-inline: 9px !important;
}

.annotation-chevron {
  transition: transform 160ms ease;
}

.annotation-chevron.expanded {
  transform: rotate(180deg);
}

.response-annotation-card {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  z-index: 20;
  width: min(448px, calc(100vw - 40px));
  max-height: min(512px, 60vh);
  overflow: auto;
  border: 1px solid var(--border-color);
  border-radius: 18px;
  background: var(--bg-card);
  box-shadow: 0 24px 54px rgba(0, 0, 0, 0.3);
}

.response-annotation-preview {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  z-index: 19;
  width: min(380px, calc(100vw - 40px));
  max-height: min(280px, 40vh);
  overflow: hidden;
  box-sizing: border-box;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: 16px;
  background: var(--bg-card);
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.26);
  pointer-events: none;
}

.response-annotation-preview ol {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.response-annotation-preview li + li {
  padding-top: 10px;
  border-top: 1px solid var(--border-light);
}

.response-annotation-preview blockquote {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.annotation-preview-comment-label {
  margin-top: 8px;
}

.response-annotation-card ol {
  margin: 0;
  padding: 0;
  list-style: none;
}

.response-annotation-card li {
  position: relative;
  padding: 16px;
}

.response-annotation-card li + li {
  border-top: 1px solid var(--border-light);
}

.annotation-row-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  opacity: 0;
}

.response-annotation-card li:hover .annotation-row-actions,
.response-annotation-card li:focus-within .annotation-row-actions {
  opacity: 1;
}

.annotation-row-actions button,
.editor-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  color: var(--text-secondary);
  background: transparent;
  cursor: pointer;
}

.annotation-row-actions button:hover,
.editor-icon:hover {
  color: var(--text-primary);
  background: var(--bg-card-hover);
}

.annotation-label {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 650;
}

blockquote {
  margin: 8px 0 0;
  padding: 9px 12px;
  border-inline-start: 3px solid var(--success);
  color: var(--text-primary);
  background: rgba(var(--success-rgb), 0.08);
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.55;
}

.annotation-divider {
  margin: 12px 0;
  border-top: 1px solid var(--border-light);
}

.annotation-comment {
  margin: 5px 0 0;
  color: var(--text-primary);
  white-space: pre-wrap;
  font-size: 13px;
}

.annotation-files,
.editor-files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.annotation-files span,
.editor-files span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--border-light);
  border-radius: 999px;
  color: var(--text-secondary);
  background: var(--bg-card-hover);
  font-size: 11px;
}

.editor-files button {
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
}

.response-annotation-editor {
  position: fixed;
  z-index: 1001;
  width: min(352px, calc(100vw - 16px));
  max-height: min(576px, calc(100vh - 16px));
  overflow: auto;
  box-sizing: border-box;
  padding: 16px;
  border: 1px solid var(--border-color);
  border-radius: 20px;
  background: var(--bg-card);
  box-shadow: 0 28px 70px rgba(0, 0, 0, 0.38);
}

.response-annotation-editor textarea {
  display: block;
  width: 100%;
  min-height: 92px;
  resize: vertical;
  box-sizing: border-box;
  padding: 11px 12px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  color: var(--text-primary);
  background: transparent;
  font: inherit;
  line-height: 1.5;
  outline: none;
}

.response-annotation-editor textarea:focus {
  border-color: var(--success);
  box-shadow: 0 0 0 2px rgba(var(--success-rgb), 0.18);
}

.editor-actions {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 13px;
}

.editor-actions > button:not(.editor-icon) {
  min-height: 34px;
  padding: 0 12px;
  border: 0;
  border-radius: 10px;
  color: var(--text-primary);
  background: transparent;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.editor-delete {
  margin-inline-start: auto;
}

.editor-save {
  color: var(--text-on-accent) !important;
  background: var(--success) !important;
  font-weight: 650 !important;
}

.editor-error {
  margin: 9px 0 0;
  color: var(--error);
  font-size: 12px;
}

@media (pointer: coarse) {
  .response-annotation-chip button,
  .annotation-row-actions button,
  .editor-icon,
  .editor-actions > button:not(.editor-icon) {
    min-height: 44px;
  }

  .annotation-row-actions button,
  .editor-icon {
    width: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .annotation-chevron {
    transition: none;
  }
}
</style>
