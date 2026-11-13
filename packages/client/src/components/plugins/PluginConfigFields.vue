<script setup lang="ts">
import { NFormItem, NInput, NInputNumber, NSwitch, NSelect } from 'naive-ui'
import { ref } from 'vue'
import type { Schema, Json } from '@/api/studio/plugins'
const props = defineProps<{ schema: Schema; modelValue: Record<string, Json> }>()
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, Json>]; valid: [value: boolean] }>()
const errors = ref<Record<string, string>>({})
const invalidChildren = new Set<string>()
function validity() { emit('valid', !Object.keys(errors.value).length && !invalidChildren.size) }
function childValidity(key: string, valid: boolean) { if (valid) invalidChildren.delete(key); else invalidChildren.add(key); validity() }
function set(key: string, value: Json | undefined) {
  const next = { ...props.modelValue }
  if (value === undefined) delete next[key]; else next[key] = value
  emit('update:modelValue', next)
}
function parse(key: string, value: string) {
  try { const parsed = value ? JSON.parse(value) : undefined; delete errors.value[key]; set(key, parsed) }
  catch (error) { errors.value[key] = error instanceof Error ? error.message : String(error) }
  validity()
}
</script>
<template>
  <NFormItem v-for="(field, key) in schema.properties" :key="key" :label="`${field.title || key}${schema.required?.includes(key) ? ' *' : ''}`" :validation-status="errors[key] ? 'error' : undefined" :feedback="errors[key]">
    <div class="config-field">
      <p v-if="field.description">{{ field.description }}</p>
      <PluginConfigFields v-if="field.type === 'object' && !field.secret" :schema="field" :model-value="(modelValue[key] || {}) as Record<string, Json>" @update:model-value="set(key, $event)" @valid="childValidity(key, $event)" />
      <NSelect v-else-if="field.enum" :value="modelValue[key] === undefined ? null : JSON.stringify(modelValue[key])" :options="field.enum.map(value => ({ label: String(value), value: JSON.stringify(value) }))" clearable @update:value="set(key, $event === null ? undefined : JSON.parse($event))" />
      <NSwitch v-else-if="field.type === 'boolean'" :value="modelValue[key] === true" @update:value="set(key, $event)" />
      <NInputNumber v-else-if="field.type === 'number' || field.type === 'integer'" :value="typeof modelValue[key] === 'number' ? modelValue[key] as number : null" :min="field.minimum" :max="field.maximum" :precision="field.type === 'integer' ? 0 : undefined" @update:value="set(key, $event === null ? undefined : $event)" />
      <NInput v-else-if="field.type === 'string'" :value="String(modelValue[key] ?? '')" :input-props="{ 'aria-label': field.title || key }" :type="field.secret ? 'password' : 'text'" :maxlength="field.maxLength" autocomplete="off" @update:value="set(key, $event || undefined)" />
      <NInput v-else type="textarea" :input-props="{ 'aria-label': field.title || key }" :default-value="JSON.stringify(modelValue[key] ?? null, null, 2)" @update:value="parse(key, $event)" />
    </div>
  </NFormItem>
</template>
<style scoped>.config-field { width: 100%; } p { margin: 0 0 6px; color: var(--text-muted); }</style>
