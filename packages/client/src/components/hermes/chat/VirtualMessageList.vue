<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  DynamicScroller,
  DynamicScrollerItem,
  type DynamicScrollerExposed,
  type ScrollToOptions,
} from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import type { MessageViewportScrollSnapshot } from "./message-scroll-position";

type VirtualItem = {
  id: string | number;
}

type AnchorAlign = "start" | "center";
type AnchorTarget = {
  token: number;
  index: number;
  messageId: string;
  anchorId: string;
  align: AnchorAlign;
  stableSince: number;
  layout: number[] | null;
  resolve: (positioned: boolean) => void;
}
type BottomScrollOptions = number | {
  frames?: number;
  keepAliveMs?: number;
}
const props = withDefaults(defineProps<{
  messages: VirtualItem[];
  virtualized?: boolean;
  estimatedItemHeight?: number;
  overscan?: number;
  rowGap?: number;
  padding?: string;
  topThreshold?: number;
}>(), {
  virtualized: true,
  estimatedItemHeight: 180,
  overscan: 8,
  rowGap: 16,
  padding: "20px",
  topThreshold: 120,
});

const emit = defineEmits<{
  scroll: [];
  topReach: [];
}>();

defineSlots<{
  empty?: () => any;
  before?: () => any;
  item?: (props: { message: any }) => any;
  after?: () => any;
}>();

const hostRef = ref<HTMLElement | null>(null);
const contentRef = ref<HTMLElement | null>(null);
const scrollerRef = ref<DynamicScrollerExposed<VirtualItem> | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(0);
let keepBottomUntil = 0;
let bottomFrame: number | null = null;
let bottomFrameRemaining = 0;
let bottomFrameAttempts = 0;
let programmaticScrollUntil = 0;
let userDetachedFromBottom = false;
let anchorFrame: number | null = null;
let anchorTimeout: ReturnType<typeof setTimeout> | null = null;
const isAligningAnchor = ref(false);
let anchorToken = 0;
let activeAnchorTarget: AnchorTarget | null = null;
let viewportRestoreFrame: number | null = null;

const messageKeys = computed(() => props.messages.map(messageKey));
const bufferPx = computed(() => Math.max(props.estimatedItemHeight, props.estimatedItemHeight * props.overscan));

function messageKey(message: VirtualItem): string {
  return String(message.id);
}

function getScrollerElement(): HTMLElement | null {
  return hostRef.value?.querySelector<HTMLElement>(".virtual-message-list") ?? null;
}

function syncViewport() {
  const el = getScrollerElement();
  if (!el) return;
  scrollTop.value = el.scrollTop;
  viewportHeight.value = el.clientHeight;
}

function markProgrammaticScroll(ms = 120) {
  programmaticScrollUntil = Date.now() + ms;
}

function isProgrammaticScroll(): boolean {
  return Date.now() < programmaticScrollUntil;
}

function cancelBottomScroll() {
  keepBottomUntil = 0;
  if (bottomFrame != null) {
    cancelAnimationFrame(bottomFrame);
    bottomFrame = null;
  }
  bottomFrameRemaining = 0;
  bottomFrameAttempts = 0;
}

function handleScroll() {
  const previousScrollTop = scrollTop.value;
  syncViewport();
  const delta = scrollTop.value - previousScrollTop;
  if (delta < -1) {
    userDetachedFromBottom = true;
    cancelBottomScroll();
  } else if (!activeAnchorTarget && !isProgrammaticScroll()) {
    if (isNearBottom(32)) {
      userDetachedFromBottom = false;
    }
    if (userDetachedFromBottom || !isNearBottom(96)) {
      cancelBottomScroll();
    }
  }
  emit("scroll");
  if (!activeAnchorTarget && scrollTop.value <= props.topThreshold) emit("topReach");
}

function handleWheel(event: WheelEvent) {
  cancelAnchorAlignment();
  if (event.deltaY < -1) {
    userDetachedFromBottom = true;
    cancelBottomScroll();
  }
}

function handleResize() {
  syncViewport();
  if (activeAnchorTarget) {
    activeAnchorTarget.layout = null;
    scheduleAnchorAlignment(activeAnchorTarget.token);
    return;
  }
  if (!userDetachedFromBottom || Date.now() < keepBottomUntil || isNearBottom(64)) {
    scheduleScrollToBottom(2);
  }
}

function isNearBottom(threshold = 200): boolean {
  const el = getScrollerElement();
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

function shouldAutoFollowBottom(threshold = 200): boolean {
  return !userDetachedFromBottom && isNearBottom(threshold);
}

function scrollToBottom(options: BottomScrollOptions = {}) {
  cancelAnchorAlignment();
  const frames = typeof options === "number" ? options : options.frames ?? 2;
  const keepAliveMs = typeof options === "number" ? 400 : options.keepAliveMs ?? 400;
  userDetachedFromBottom = false;
  keepBottomUntil = Date.now() + keepAliveMs;
  nextTick(() => {
    if (userDetachedFromBottom) return;
    scheduleScrollToBottom(frames);
  });
}

function setScrollToBottomNow(): boolean {
  const el = getScrollerElement();
  markProgrammaticScroll();
  if (props.virtualized) scrollerRef.value?.scrollToBottom();
  if (el) {
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    syncViewport();
    return true;
  }
  return false;
}

function scheduleScrollToBottom(frames = 1) {
  bottomFrameRemaining = Math.max(bottomFrameRemaining, frames);
  if (bottomFrame != null) return;

  const step = () => {
    const scrolled = setScrollToBottomNow();
    if (scrolled) {
      bottomFrameAttempts = 0;
      bottomFrameRemaining -= 1;
    } else {
      bottomFrameAttempts += 1;
    }
    if (bottomFrameRemaining <= 0) {
      bottomFrame = null;
      bottomFrameRemaining = 0;
      bottomFrameAttempts = 0;
      return;
    }
    if (bottomFrameAttempts > 30) {
      bottomFrame = null;
      bottomFrameRemaining = 0;
      bottomFrameAttempts = 0;
      return;
    }
    bottomFrame = requestAnimationFrame(step);
  };

  bottomFrame = requestAnimationFrame(step);
}

function findTargetElement(messageId: string, anchorId: string): HTMLElement | null {
  const el = getScrollerElement();
  if (!el) return null;

  const anchor = document.getElementById(anchorId);
  if (anchor instanceof HTMLElement && el.contains(anchor)) return anchor;

  const message = document.getElementById(`message-${messageId}`);
  if (message instanceof HTMLElement && el.contains(message)) return message;

  return null;
}

function alignElement(targetEl: HTMLElement, align: AnchorAlign) {
  const el = getScrollerElement();
  if (!el) return false;

  const scrollerRect = el.getBoundingClientRect();
  const targetRect = targetEl.getBoundingClientRect();
  const delta = align === "center"
    ? targetRect.top + targetRect.height / 2 - (scrollerRect.top + scrollerRect.height / 2)
    : targetRect.top - scrollerRect.top - 24;

  const previousScrollTop = el.scrollTop;
  if (Math.abs(delta) > 1) {
    markProgrammaticScroll();
    el.scrollTop = Math.max(0, el.scrollTop + delta);
  }
  syncViewport();
  return Math.abs(el.scrollTop - previousScrollTop) > 1;
}

function findRowElement(index: number): HTMLElement | null {
  const el = getScrollerElement();
  return el?.querySelector<HTMLElement>(`.virtual-row[data-virtual-index="${index}"]`) ?? null;
}

function scrollToItem(index: number, options?: ScrollToOptions) {
  markProgrammaticScroll();
  if (props.virtualized) {
    scrollerRef.value?.scrollToItem(index, options);
    syncViewport();
    return;
  }

  const el = getScrollerElement();
  const row = findRowElement(index);
  if (!el || !row) {
    syncViewport();
    return;
  }

  const rowRect = row.getBoundingClientRect();
  const scrollerRect = el.getBoundingClientRect();
  const align = options?.align ?? "start";
  const offset = options?.offset ?? 0;
  const delta = align === "center"
    ? rowRect.top + rowRect.height / 2 - (scrollerRect.top + scrollerRect.height / 2)
    : rowRect.top - scrollerRect.top + offset;

  el.scrollTop = Math.max(0, el.scrollTop + delta);
  syncViewport();
}

function hasPendingRowMeasurements(el: HTMLElement): boolean {
  const scroller = scrollerRef.value;
  if (!props.virtualized || !scroller) return false;
  return Array.from(el.querySelectorAll<HTMLElement>(".virtual-row")).some(row => {
    const index = Number(row.dataset.virtualIndex);
    const message = props.messages[index];
    const height = row.getBoundingClientRect().height;
    return !!message && height > 0 && Math.abs(scroller.getItemSize(message, index) - height) > 1;
  });
}

function scheduleAnchorAlignment(token: number) {
  if (anchorFrame != null) return;

  const step = () => {
    const target = activeAnchorTarget;
    if (!target || target.token !== token) {
      anchorFrame = null;
      return;
    }

    const targetEl = findTargetElement(target.messageId, target.anchorId);
    const el = getScrollerElement();
    // A boundary row can leave the recycled window before its ResizeObserver
    // result reaches the size cache. Re-centering against that stale size can
    // alternate the window forever. Let visible rows finish measuring first.
    if (targetEl && el && hasPendingRowMeasurements(el)) {
      target.layout = null;
      target.stableSince = performance.now();
      anchorFrame = requestAnimationFrame(step);
      return;
    }

    let corrected = false;
    if (targetEl) {
      corrected = alignElement(targetEl, target.align);
    } else {
      scrollToItem(target.index, {
        align: target.align,
        offset: target.align === "start" ? -24 : 0,
      });
    }

    if (targetEl && el) {
      const rect = targetEl.getBoundingClientRect();
      const layout = [el.scrollTop, el.scrollHeight, el.clientHeight, rect.top - el.getBoundingClientRect().top, rect.height];
      const unchanged = target.layout?.every((value, index) => Math.abs(value - layout[index]) <= 1);
      const imagesReady = Array.from(el.querySelectorAll("img")).every(image => image.complete);
      if (corrected || !unchanged || !imagesReady || rect.height === 0 || el.clientHeight === 0) {
        target.stableSince = performance.now();
      }
      target.layout = layout;
      // Wait for a quiet layout, including virtual-row size measurements.
      // A fixed number of scroll retries can end while rows are still moving.
      if (performance.now() - target.stableSince >= 250) {
        finishAnchorAlignment(true);
        return;
      }
    } else {
      target.layout = null;
      target.stableSince = performance.now();
    }
    anchorFrame = requestAnimationFrame(step);
  };

  anchorFrame = requestAnimationFrame(step);
}

function finishAnchorAlignment(positioned: boolean) {
  const target = activeAnchorTarget;
  anchorToken += 1;
  activeAnchorTarget = null;
  isAligningAnchor.value = false;
  if (anchorTimeout != null) {
    clearTimeout(anchorTimeout);
    anchorTimeout = null;
  }
  if (anchorFrame != null) {
    cancelAnimationFrame(anchorFrame);
    anchorFrame = null;
  }
  target?.resolve(positioned);
}

function cancelAnchorAlignment() {
  finishAnchorAlignment(false);
}

function positionAnchor(messageId: string, anchorId: string, align: AnchorAlign): Promise<boolean> {
  cancelAnchorAlignment();
  const index = props.messages.findIndex(message => String(message.id) === messageId);
  if (index < 0) return Promise.resolve(false);

  userDetachedFromBottom = true;
  cancelBottomScroll();
  if (viewportRestoreFrame != null) cancelAnimationFrame(viewportRestoreFrame);
  viewportRestoreFrame = null;
  const token = anchorToken;
  return new Promise(resolve => {
    isAligningAnchor.value = true;
    activeAnchorTarget = {
      token, index, messageId, anchorId, align,
      stableSince: performance.now(), layout: null, resolve,
    };
    // Broken media or a disappearing target must not leave the caller loading.
    anchorTimeout = setTimeout(() => finishAnchorAlignment(false), 5000);
    nextTick(() => {
      if (activeAnchorTarget?.token !== token) return;
      scrollToItem(index, { align, offset: align === "start" ? -24 : 0 });
      scheduleAnchorAlignment(token);
    });
  });
}

function scrollToMessage(messageId: string): Promise<boolean> {
  return positionAnchor(messageId, `message-${messageId}`, "center");
}

function scrollToAnchor(messageId: string, anchorId: string): Promise<boolean> {
  return positionAnchor(messageId, anchorId, "start");
}

function captureScrollPosition() {
  const el = getScrollerElement();
  if (!el) return null;
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
  };
}

function restoreScrollPosition(snapshot: { scrollTop: number; scrollHeight: number } | null) {
  if (!snapshot) return;
  nextTick(() => {
    const el = getScrollerElement();
    if (!el) return;
    const nextScrollTop = Math.max(0, el.scrollHeight - snapshot.scrollHeight + snapshot.scrollTop);
    markProgrammaticScroll();
    if (props.virtualized) scrollerRef.value?.scrollToPosition(nextScrollTop);
    el.scrollTop = nextScrollTop;
    syncViewport();
  });
}

function findViewportAnchor(el: HTMLElement): { messageId: string; offset: number } | null {
  const scrollerRect = el.getBoundingClientRect();
  const viewportBottom = scrollerRect.bottom || scrollerRect.top + el.clientHeight;
  let candidate: { messageId: string; offset: number; top: number } | null = null;

  for (const row of el.querySelectorAll<HTMLElement>(".virtual-row[data-virtual-index]")) {
    const rowRect = row.getBoundingClientRect();
    if (rowRect.bottom <= scrollerRect.top || rowRect.top >= viewportBottom) continue;
    const index = Number(row.dataset.virtualIndex);
    const message = Number.isInteger(index) ? props.messages[index] : null;
    const messageId = row.dataset.messageId || (message ? messageKey(message) : "");
    if (!messageId) continue;
    if (!candidate || rowRect.top < candidate.top) {
      candidate = {
        messageId,
        offset: rowRect.top - scrollerRect.top,
        top: rowRect.top,
      };
    }
  }

  return candidate
    ? { messageId: candidate.messageId, offset: candidate.offset }
    : null;
}

function captureViewportPosition(): MessageViewportScrollSnapshot | null {
  const el = getScrollerElement();
  if (!el) return null;
  const anchor = findViewportAnchor(el);
  return {
    anchorMessageId: anchor?.messageId || null,
    anchorOffset: anchor?.offset || 0,
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    wasNearBottom: isNearBottom(64),
  };
}

function restoreViewportPosition(snapshot: MessageViewportScrollSnapshot | null, frames = 4): boolean {
  if (!snapshot) return false;
  if (viewportRestoreFrame != null) {
    cancelAnimationFrame(viewportRestoreFrame);
    viewportRestoreFrame = null;
  }
  const anchorMessageId = snapshot.anchorMessageId;
  const initialIndex = anchorMessageId
    ? props.messages.findIndex(message => messageKey(message) === anchorMessageId)
    : -1;
  if (!anchorMessageId || initialIndex < 0) {
    scrollToBottom();
    return false;
  }

  cancelBottomScroll();
  cancelAnchorAlignment();
  userDetachedFromBottom = !snapshot.wasNearBottom;
  const anchorOffset = Number.isFinite(snapshot.anchorOffset) ? snapshot.anchorOffset : 0;

  nextTick(() => {
    let remaining = frames;
    const step = () => {
      const el = getScrollerElement();
      if (!el) {
        viewportRestoreFrame = null;
        return;
      }
      const index = props.messages.findIndex(message => messageKey(message) === anchorMessageId);
      if (index < 0) {
        viewportRestoreFrame = null;
        scrollToBottom();
        return;
      }

      const row = findRowElement(index);
      if (row) {
        const scrollerRect = el.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
        const delta = rowRect.top - scrollerRect.top - anchorOffset;
        const nextScrollTop = Math.min(maxScrollTop, Math.max(0, el.scrollTop + delta));
        markProgrammaticScroll();
        if (props.virtualized) scrollerRef.value?.scrollToPosition(nextScrollTop);
        el.scrollTop = nextScrollTop;
        syncViewport();
      } else {
        scrollToItem(index, { align: "start", offset: -anchorOffset });
      }

      remaining -= 1;
      if (remaining <= 0) {
        viewportRestoreFrame = null;
        return;
      }
      viewportRestoreFrame = requestAnimationFrame(step);
    };
    viewportRestoreFrame = requestAnimationFrame(step);
  });

  return true;
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  nextTick(() => {
    syncViewport();
    const el = getScrollerElement();
    if (el && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(el);
      const content = contentRef.value
        ?? el.querySelector<HTMLElement>(".vue-recycle-scroller__item-wrapper");
      if (content) resizeObserver.observe(content);
    }
  });
});

onBeforeUnmount(() => {
  cancelBottomScroll();
  cancelAnchorAlignment();
  if (viewportRestoreFrame != null) cancelAnimationFrame(viewportRestoreFrame);
  resizeObserver?.disconnect();
});

watch(messageKeys, () => {
  if (activeAnchorTarget) {
    const index = messageKeys.value.indexOf(activeAnchorTarget.messageId);
    if (index < 0) cancelAnchorAlignment();
    else {
      activeAnchorTarget.index = index;
      activeAnchorTarget.layout = null;
    }
  }
  nextTick(syncViewport);
});

defineExpose({
  isNearBottom,
  shouldAutoFollowBottom,
  scrollToBottom,
  scrollToMessage,
  scrollToAnchor,
  cancelAnchorAlignment,
  captureScrollPosition,
  restoreScrollPosition,
  captureViewportPosition,
  restoreViewportPosition,
});
</script>

<template>
  <div
    ref="hostRef"
    class="virtual-message-list-host"
    :class="{ 'virtual-message-list-host--positioning': isAligningAnchor }"
    :style="{ '--virtual-row-gap': `${rowGap}px`, '--virtual-list-padding': padding }"
  >
    <DynamicScroller
      v-if="virtualized"
      ref="scrollerRef"
      class="virtual-message-list"
      :items="messages"
      key-field="id"
      :min-item-size="estimatedItemHeight"
      :buffer="bufferPx"
      :flow-mode="true"
      :prerender="overscan"
      @scroll.passive="handleScroll"
      @wheel.passive="handleWheel"
      @touchstart.passive="cancelAnchorAlignment"
      @pointerdown="cancelAnchorAlignment"
      @resize="handleResize"
      @visible="syncViewport"
    >
      <template #before>
        <slot v-if="messages.length > 0" name="before" />
      </template>
      <template #default="{ item, index, active }">
        <!-- Recreate measurement observers when a row is recycled or reactivated,
             so delayed measurements cannot keep another message's stale size. -->
        <DynamicScrollerItem
          v-if="active"
          :key="messageKey(item)"
          :item="item"
          :index="index"
          :active="active"
          class="virtual-row"
          :data-virtual-index="index"
          :data-message-id="messageKey(item)"
        >
          <slot name="item" :message="item" />
        </DynamicScrollerItem>
      </template>
      <template #after>
        <slot v-if="messages.length > 0" name="after" />
      </template>
    </DynamicScroller>
    <div
      v-else
      class="virtual-message-list"
      @scroll.passive="handleScroll"
      @wheel.passive="handleWheel"
      @touchstart.passive="cancelAnchorAlignment"
      @pointerdown="cancelAnchorAlignment"
    >
      <div ref="contentRef" class="virtual-message-list-content">
        <slot v-if="messages.length > 0" name="before" />
        <div
          v-for="(item, index) in messages"
          :key="messageKey(item)"
          class="virtual-row"
          :data-virtual-index="index"
          :data-message-id="messageKey(item)"
        >
          <slot name="item" :message="item" />
        </div>
        <slot v-if="messages.length > 0" name="after" />
      </div>
    </div>
    <div v-if="messages.length === 0 && $slots.empty" class="virtual-message-list-empty">
      <slot name="empty" />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.virtual-message-list-host {
  flex: 1;
  min-height: 0;
  min-width: 0;
  max-width: 100%;
  display: flex;
  position: relative;
}

.virtual-message-list {
  flex: 1;
  min-height: 0;
  min-width: 0;
  max-width: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  padding: var(--virtual-list-padding);
  box-sizing: border-box;
  background-color: $bg-main-surface;
}

.virtual-message-list-host--positioning .virtual-message-list {
  overflow-anchor: none;
  scroll-behavior: auto;
}

.virtual-row {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  padding-bottom: var(--virtual-row-gap);
}

.virtual-message-list-content {
  min-width: 0;
  max-width: 100%;
}

.virtual-message-list-empty {
  position: absolute;
  inset: var(--virtual-list-padding);
  display: grid;
  place-items: center;
  min-width: 0;
  min-height: 0;
  pointer-events: auto;
}

.virtual-message-list-empty :deep(.empty-state) {
  width: 100%;
  height: 100%;
  min-height: 0;
}

</style>
