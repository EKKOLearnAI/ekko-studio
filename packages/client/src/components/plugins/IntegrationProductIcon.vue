<script setup lang="ts">
import { ref } from 'vue'
import type { IntegrationBrand } from '@/plugins/integration-brand'

defineProps<{ brand: Readonly<IntegrationBrand> }>()
const loaded = ref(false)
const failed = ref(false)
</script>

<template>
  <a v-if="!failed" v-show="loaded" class="integration-product-icon" :href="brand.website"
    target="_blank" rel="noopener noreferrer" :aria-label="brand.product">
    <img alt="" width="28" height="28" crossorigin="anonymous" referrerpolicy="no-referrer" :src="brand.image"
      @load="loaded = true" @error="failed = true" />
  </a>
  <slot v-if="!loaded || failed" />
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.integration-product-icon {
  display: inline-grid;
  place-items: center;
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
}
.integration-product-icon:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; }
.integration-product-icon img { display: block; width: 28px; height: 28px; object-fit: contain; }
</style>
