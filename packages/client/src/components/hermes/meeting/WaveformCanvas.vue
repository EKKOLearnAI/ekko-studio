<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { NSpin } from 'naive-ui'

/**
 * 实时声浪可视化。
 *
 * 从 MeetingView 拆出的第一个内聚块样品：canvas + AnalyserNode 绘制 + RAF 动画生命周期。
 * 父组件只管把 analyser 传进来（录音开始时赋值、停止时置 null），
 * 本组件自己负责起停 RAF 与卸载清理。
 */
const props = defineProps<{
  analyser: AnalyserNode | null
  connecting: boolean
}>()

const { t } = useI18n()

const canvasRef = ref<HTMLCanvasElement | null>(null)
let rafId: number | null = null

function stop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

function start() {
  stop()
  const canvas = canvasRef.value
  const analyserNode = props.analyser
  if (!canvas || !analyserNode) return

  const ctx2d = canvas.getContext('2d')
  if (!ctx2d) return

  const width = canvas.width
  const height = canvas.height
  const bufferLength = analyserNode.frequencyBinCount
  const dataArray = new Uint8Array(bufferLength)

  function draw() {
    rafId = requestAnimationFrame(draw)
    if (!analyserNode || !ctx2d) return
    analyserNode.getByteFrequencyData(dataArray)

    ctx2d.fillStyle = 'rgb(15, 23, 42)'
    ctx2d.fillRect(0, 0, width, height)

    const barWidth = (width / bufferLength) * 2.5
    let x = 0

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * height * 0.8

      const gradient = ctx2d.createLinearGradient(0, height - barHeight, 0, height)
      gradient.addColorStop(0, '#8b5cf6')
      gradient.addColorStop(1, '#6366f1')

      ctx2d.fillStyle = gradient
      ctx2d.fillRect(x, height - barHeight, barWidth, barHeight)

      x += barWidth + 1
    }
  }

  draw()
}

// analyser 由 null → 实例时自动开始绘制，回 null 时停止。
// immediate:false + onMounted 让第一次启动在 canvas 模板 ref 绑定后再触发。
watch(() => props.analyser, (a) => {
  if (a) start()
  else stop()
}, { immediate: false })

onMounted(() => {
  nextTick(() => {
    if (props.analyser) start()
  })
})

onBeforeUnmount(stop)
</script>

<template>
  <div class="waveform-container">
    <canvas ref="canvasRef" width="600" height="100"></canvas>
    <div v-if="connecting" class="connecting-overlay">
      <NSpin size="small" />
      <span>{{ t('meeting.connecting') }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.waveform-container {
  height: 100px;
  background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card)));
  position: relative;
  overflow: hidden;

  canvas {
    width: 100%;
    height: 100%;
  }

  .connecting-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: rgba(var(--text-primary-rgb), 0.5);
    color: var(--text-primary);
    font-size: 14px;
  }
}
</style>
