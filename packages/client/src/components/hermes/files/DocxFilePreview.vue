<script setup lang="ts">
import { NSpin } from 'naive-ui'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { assertBoundedOoxmlArchive } from '@/utils/hermes/ooxml-archive'

const MAX_DOCX_DOM_NODES = 50_000
const props = defineProps<{ data: ArrayBuffer }>()
const emit = defineEmits<{ (event: 'error', error: Error): void }>()
const container = ref<HTMLElement | null>(null)
const loading = ref(true)
let generation = 0

function disableActiveDocumentContent(root: HTMLElement): void {
  root.querySelectorAll('script, iframe, frame, object, embed, applet, form').forEach(node => node.remove())
  root.querySelectorAll('style').forEach(style => {
    style.textContent = (style.textContent || '')
      .replace(/@import[\s\S]*?;/gi, '')
      .replace(/url\(\s*(['"]?)(?!data:|blob:)[^)]+\)/gi, 'none')
  })
  root.querySelectorAll('*').forEach(element => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || ['href', 'srcset', 'action', 'formaction', 'xlink:href'].includes(name)) {
        element.removeAttribute(attribute.name)
      } else if (name === 'src' && !/^(?:data:|blob:)/i.test(attribute.value.trim())) {
        element.removeAttribute(attribute.name)
      } else if (name === 'style') {
        element.setAttribute('style', attribute.value.replace(/url\(\s*(['"]?)(?!data:|blob:)[^)]+\)/gi, 'none'))
      }
    }
  })
}

async function renderDocument(): Promise<void> {
  const currentGeneration = ++generation
  loading.value = true
  try {
    const target = container.value
    if (!target) return
    target.replaceChildren()
    assertBoundedOoxmlArchive(props.data)
    const { renderAsync } = await import('docx-preview')
    if (currentGeneration !== generation) return
    const staging = document.createElement('div')
    await renderAsync(props.data.slice(0), staging, staging, {
      className: 'generated-docx',
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      useBase64URL: true,
    })
    if (currentGeneration !== generation) return
    if (staging.querySelectorAll('*').length > MAX_DOCX_DOM_NODES) {
      throw new Error('Document exceeds the render element limit')
    }
    disableActiveDocumentContent(staging)
    const fragment = document.createDocumentFragment()
    while (staging.firstChild) fragment.appendChild(staging.firstChild)
    target.replaceChildren(fragment)
  } catch (error) {
    if (currentGeneration === generation) {
      emit('error', error instanceof Error ? error : new Error(String(error)))
    }
  } finally {
    if (currentGeneration === generation) loading.value = false
  }
}

watch(() => props.data, renderDocument)
onMounted(renderDocument)
onBeforeUnmount(() => {
  generation += 1
  container.value?.replaceChildren()
})
</script>

<template>
  <NSpin :show="loading" class="docx-stage">
    <div ref="container" class="docx-container" />
  </NSpin>
</template>

<style scoped lang="scss">
.docx-stage { width: 100%; min-height: 420px; overflow: auto; background: rgba(127, 127, 127, 0.08); }
.docx-container { width: 100%; min-height: 420px; }
.docx-container :deep(a) { pointer-events: none; }
</style>
