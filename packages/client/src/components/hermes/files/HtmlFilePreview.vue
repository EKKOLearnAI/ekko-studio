<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NButtonGroup, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { handleCodeBlockCopyClick, renderHighlightedCodeBlock } from '@/components/hermes/chat/highlight'

const props = defineProps<{ content: string }>()
const { t } = useI18n()
const message = useMessage()
const mode = ref<'preview' | 'source'>('preview')

function buildSafeSrcdoc(source: string): string {
  const document = new DOMParser().parseFromString(source, 'text/html')
  document.querySelectorAll('script, iframe, frame, frameset, object, embed, applet, form, base').forEach(node => node.remove())
  document.querySelectorAll('meta[http-equiv]').forEach(node => node.remove())
  document.querySelectorAll('*').forEach(element => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || ['href', 'srcset', 'action', 'formaction', 'xlink:href'].includes(name)) {
        element.removeAttribute(attribute.name)
      } else if (name === 'src' && !/^(?:data:|blob:)/i.test(attribute.value.trim())) {
        element.removeAttribute(attribute.name)
      }
    }
  })
  const csp = document.createElement('meta')
  csp.httpEquiv = 'Content-Security-Policy'
  csp.content = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; frame-src 'none'; child-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; navigate-to 'none'"
  const scrollbarStyle = document.createElement('style')
  scrollbarStyle.textContent = 'html, body { scrollbar-width: none; } html::-webkit-scrollbar, body::-webkit-scrollbar, *::-webkit-scrollbar { display: none; width: 0; height: 0; }'
  document.head.prepend(csp)
  document.head.append(scrollbarStyle)
  return `<!doctype html>${document.documentElement.outerHTML}`
}

const safeSrcdoc = computed(() => buildSafeSrcdoc(props.content))
const highlightedSource = computed(() => renderHighlightedCodeBlock(props.content, 'html', t('common.copy'), {
  maxHighlightLength: 500_000,
}))

async function handleSourceClick(event: MouseEvent): Promise<void> {
  const result = await handleCodeBlockCopyClick(event)
  if (result) message.success(t('common.copied'))
  else if (result === false) message.error(t('chat.copyFailed'))
}
</script>

<template>
  <div class="html-preview">
    <NButtonGroup size="small" class="mode-switch">
      <NButton :type="mode === 'preview' ? 'primary' : 'default'" @click="mode = 'preview'">{{ t('files.previewMode') }}</NButton>
      <NButton :type="mode === 'source' ? 'primary' : 'default'" @click="mode = 'source'">{{ t('files.sourceMode') }}</NButton>
    </NButtonGroup>
    <iframe
      v-if="mode === 'preview'"
      class="html-frame"
      sandbox=""
      referrerpolicy="no-referrer"
      :srcdoc="safeSrcdoc"
      :title="t('files.htmlPreviewTitle')"
    />
    <div
      v-else
      class="source-view"
      v-html="highlightedSource"
      @click="handleSourceClick"
    />
  </div>
</template>

<style scoped lang="scss">
.html-preview { flex: 1; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; gap: calc(10px * var(--spacing-scale, 1)); }
.mode-switch { align-self: flex-start; }
.html-frame { flex: 1; width: 100%; height: 100%; min-height: 0; border: var(--border-width, 1px) solid var(--n-border-color); border-radius: var(--radius-component, 6px); background: white; box-sizing: border-box; scrollbar-width: none; }
.html-frame::-webkit-scrollbar { display: none; width: 0; height: 0; }
.source-view {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  border-radius: var(--radius-component, 6px);
  background: rgba(127, 127, 127, 0.08);
  scrollbar-width: none;

  &::-webkit-scrollbar { display: none; width: 0; height: 0; }

  :deep(.hljs-code-block) {
    height: auto;
    min-height: 100%;
    max-height: none;
    margin: 0;
    overflow: visible;
  }

  :deep(code.hljs) {
    min-height: 100%;
    overflow: visible;
  }
}
</style>
