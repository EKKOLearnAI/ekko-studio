<script setup lang="ts">
import { ref, computed } from 'vue'
import { NSwitch, useMessage, useDialog } from 'naive-ui'
import type { SkillCategory, SkillSource, SkillInfo } from '@/api/hermes/skills'
import { toggleSkill, deleteSkillApi } from '@/api/hermes/skills'
import { useI18n } from 'vue-i18n'

type SourceFilter = SkillSource | 'modified'

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()

const props = withDefaults(defineProps<{
    categories: SkillCategory[]
    archived: SkillInfo[]
    selectedSkill: string | null
    searchQuery: string
    sourceFilter: SourceFilter | null
    readonly?: boolean
    toggleable?: boolean
    toggleHandler?: (category: string, skill: string, enabled: boolean) => Promise<void>
    deleteHandler?: (category: string, skill: string) => Promise<void>
}>(), {
    toggleable: true,
})

const emit = defineEmits<{
    select: [category: string, skill: string]
    deleted: [category: string, skill: string]
}>()

const collapsedCategories = ref<Set<string>>(new Set())
const archiveCollapsed = ref(true)
const togglingSkills = ref<Set<string>>(new Set())
const deletingSkills = ref<Set<string>>(new Set())

const filteredArchived = computed(() => {
    let result = props.archived
    if (props.sourceFilter && props.sourceFilter !== 'modified') {
        result = result.filter(s => (s.source || 'local') === props.sourceFilter)
    }
    if (props.searchQuery) {
        const q = props.searchQuery.toLowerCase()
        result = result.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
    }
    return result
})

const filteredCategories = computed(() => {
    let result = props.categories

    // Filter by source
    if (props.sourceFilter) {
        result = result
            .map(cat => ({
                ...cat,
                skills: cat.skills.filter(s => {
                    if (props.sourceFilter === 'modified') return s.modified
                    return (s.source || 'local') === props.sourceFilter
                }),
            }))
            .filter(cat => cat.skills.length > 0)
    }

    // Filter by search query
    if (props.searchQuery) {
        const q = props.searchQuery.toLowerCase()
        result = result
            .map(cat => ({
                ...cat,
                skills: cat.skills.filter(
                    s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
                ),
            }))
            .filter(cat => cat.skills.length > 0 || cat.name.toLowerCase().includes(q))
    }

    return result
})

/**
 * When the user filters down to "external", regroup the result so the outer
 * level is the configured external dir (raw `~/...` form) and the inner level
 * is the original category. This makes it easy to see which entries come from
 * which external source — the path itself is what the user typed in the
 * external-dirs config.
 *
 * Returns an array of { path, categories[] } groups; falsy when the filter
 * isn't external, so the template falls back to the flat category list.
 */
interface ExternalGroup {
    path: string
    categories: { name: string; skills: typeof props.categories[number]['skills'] }[]
}

const externalGroups = computed<ExternalGroup[] | null>(() => {
    if (props.sourceFilter !== 'external') return null
    // Map<path, Map<categoryName, skills[]>>
    const byPath = new Map<string, Map<string, typeof props.categories[number]['skills']>>()
    const orderPath: string[] = []
    const orderCat = new Map<string, string[]>()
    for (const cat of filteredCategories.value) {
        for (const skill of cat.skills) {
            const path = skill.sourcePath || ''
            if (!byPath.has(path)) {
                byPath.set(path, new Map())
                orderPath.push(path)
                orderCat.set(path, [])
            }
            const catMap = byPath.get(path)!
            if (!catMap.has(cat.name)) {
                catMap.set(cat.name, [])
                orderCat.get(path)!.push(cat.name)
            }
            catMap.get(cat.name)!.push(skill)
        }
    }
    return orderPath.map(path => ({
        path,
        categories: orderCat.get(path)!.map(name => ({
            name,
            skills: byPath.get(path)!.get(name)!,
        })),
    }))
})

const collapsedPaths = ref<Set<string>>(new Set())

function togglePath(path: string) {
    if (collapsedPaths.value.has(path)) collapsedPaths.value.delete(path)
    else collapsedPaths.value.add(path)
}

/** Display path verbatim. RTL trick in CSS truncates the start when too long. */
function shortenPath(path: string): string {
    return path || '(unknown)'
}

function toggleCategory(name: string) {
    if (collapsedCategories.value.has(name)) {
        collapsedCategories.value.delete(name)
    } else {
        collapsedCategories.value.add(name)
    }
}

function handleSelect(category: string, skillName: string) {
    emit('select', category, skillName)
}

/** Unique key for selection tracking */
function skillKey(catName: string, skill: { name: string }): string {
    return `${catName}/${skill.name}`
}

async function handleToggle(category: string, skillName: string, newEnabled: boolean) {
    if (togglingSkills.value.has(skillName)) return
    togglingSkills.value.add(skillName)

    try {
        if (props.toggleHandler) await props.toggleHandler(category, skillName, newEnabled)
        else await toggleSkill(skillName, newEnabled)
        // Update local state
        const cat = props.categories.find(c => c.name === category)
        const skill = cat?.skills.find(s => s.name === skillName)
        if (skill) skill.enabled = newEnabled
    } catch (err: any) {
        message.error(t('skills.toggleFailed') + `: ${err.message}`)
    } finally {
        togglingSkills.value.delete(skillName)
    }
}

function confirmDelete(category: string, skillName: string) {
    if (deletingSkills.value.has(skillName)) return
    dialog.warning({
        title: t('skills.delete'),
        content: t('skills.deleteConfirm', { name: skillName }),
        positiveText: t('common.delete'),
        negativeText: t('common.cancel'),
        onPositiveClick: async () => {
            deletingSkills.value.add(skillName)
            try {
                if (props.deleteHandler) await props.deleteHandler(category, skillName)
                else await deleteSkillApi(category, skillName)
                message.success(t('skills.deleteSuccess'))
                message.info(t('skills.reloadHint'), { duration: 6000 })
                emit('deleted', category, skillName)
            } catch (err: any) {
                message.error(t('skills.deleteFailed') + `: ${err.message}`)
            } finally {
                deletingSkills.value.delete(skillName)
            }
        },
    })
}
</script>

<template>
    <div class="skill-list">
        <div v-if="filteredCategories.length === 0" class="skill-empty">
            {{ searchQuery ? t('skills.noMatch') : t('skills.noSkills') }}
        </div>

        <!-- External filter: regroup as <path> → <category> → skill -->
        <template v-if="externalGroups">
            <div v-for="group in externalGroups" :key="group.path || '__unknown__'" class="skill-path-group">
                <button class="path-header" :title="group.path || ''" @click="togglePath(group.path)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-width="2" class="category-arrow"
                        :class="{ collapsed: collapsedPaths.has(group.path) }">
                        <polyline points="6 9 12 15 18 9" />
                    </svg>
                    <span class="path-header-icon">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                    </span>
                    <span class="path-header-text">{{ shortenPath(group.path) }}</span>
                    <span class="category-count">{{ group.categories.reduce((n, c) => n + c.skills.length, 0) }}</span>
                </button>
                <div v-if="!collapsedPaths.has(group.path)" class="path-group-body">
                    <div v-for="cat in group.categories" :key="cat.name" class="skill-category">
                        <button class="category-header sub" @click="toggleCategory(group.path + '::' + cat.name)">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                stroke-width="2" class="category-arrow"
                                :class="{ collapsed: collapsedCategories.has(group.path + '::' + cat.name) }">
                                <polyline points="6 9 12 15 18 9" />
                            </svg>
                            <span class="category-name">{{ cat.name }}</span>
                            <span class="category-count">{{ cat.skills.length }}</span>
                        </button>
                        <div v-if="!collapsedCategories.has(group.path + '::' + cat.name)" class="category-skills">
                            <button v-for="skill in cat.skills" :key="skillKey(cat.name, skill)" class="skill-item"
                                :class="[
                                    { active: selectedSkill === skillKey(cat.name, skill) },
                                    `source-${skill.source || 'local'}`,
                                ]" @click="handleSelect(cat.name, skill.name)">
                                <div class="skill-info">
                                    <span class="skill-name">
                                        <span class="source-dot" :class="`dot-${skill.source || 'local'}`"
                                            :title="t(`skills.source.${skill.source || 'local'}`)" />
                                        {{ skill.name }}
                                        <span v-if="skill.modified" class="modified-badge"
                                            :title="t('skills.modified')">✎</span>
                                    </span>
                                    <span v-if="skill.description" class="skill-desc">{{ skill.description }}</span>
                                </div>
                                <NSwitch v-if="!readonly && !skill.readonly && toggleable !== false" size="small" :value="skill.enabled !== false"
                                    :loading="togglingSkills.has(skill.name)"
                                    @update:value="handleToggle(cat.name, skill.name, $event)" @click.stop />
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </template>

        <!-- Default flat category list -->
        <template v-else>
            <div v-for="cat in filteredCategories" :key="cat.name" class="skill-category">
                <button class="category-header" @click="toggleCategory(cat.name)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                        class="category-arrow" :class="{ collapsed: collapsedCategories.has(cat.name) }">
                        <polyline points="6 9 12 15 18 9" />
                    </svg>
                    <span class="category-name">{{ cat.name }}</span>
                    <span class="category-count">{{ cat.skills.length }}</span>
                </button>
                <div v-if="!collapsedCategories.has(cat.name)" class="category-skills">
                    <button v-for="skill in cat.skills" :key="skillKey(cat.name, skill)" class="skill-item" :class="[
                        { active: selectedSkill === skillKey(cat.name, skill) },
                        `source-${skill.source || 'local'}`,
                    ]" @click="handleSelect(cat.name, skill.name)">
                        <div class="skill-info">
                            <span class="skill-name">
                                <span class="source-dot" :class="`dot-${skill.source || 'local'}`"
                                    :title="t(`skills.source.${skill.source || 'local'}`)" />
                                {{ skill.name }}
                                <span v-if="skill.modified" class="modified-badge"
                                    :title="t('skills.modified')">✎</span>
                            </span>
                            <span v-if="skill.description" class="skill-desc">{{ skill.description }}</span>
                        </div>
                        <button v-if="!readonly && !skill.readonly && (skill.source ?? 'local') === 'local'" class="skill-action-btn"
                            :title="t('skills.delete')" :disabled="deletingSkills.has(skill.name)"
                            @click.stop="confirmDelete(cat.name, skill.name)">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
                                <path d="M10 11v6" />
                                <path d="M14 11v6" />
                                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                            </svg>
                        </button>
                        <NSwitch v-if="!readonly && !skill.readonly && toggleable !== false" size="small" :value="skill.enabled !== false"
                            :loading="togglingSkills.has(skill.name)"
                            @update:value="handleToggle(cat.name, skill.name, $event)" @click.stop />
                    </button>
                </div>
            </div>
        </template>

        <!-- Archived skills (separate section) -->
        <div v-if="filteredArchived.length > 0 || archived.length > 0" class="skill-category archive-section">
            <button class="category-header archive-header" @click="archiveCollapsed = !archiveCollapsed">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                    class="category-arrow" :class="{ collapsed: archiveCollapsed }">
                    <polyline points="6 9 12 15 18 9" />
                </svg>
                <span class="category-name">{{ t('skills.archived') }}</span>
                <span class="category-count">{{ archived.length }}</span>
            </button>
            <div v-if="!archiveCollapsed" class="category-skills">
                <button v-for="skill in filteredArchived" :key="skillKey('.archive', skill)" class="skill-item skill-archived"
                    :class="{ active: selectedSkill === skillKey('.archive', skill) }"
                    @click="handleSelect('.archive', skill.name)">
                    <div class="skill-info">
                        <span class="skill-name">
                            <span class="source-dot" :class="`dot-${skill.source || 'local'}`"
                                :title="t(`skills.source.${skill.source || 'local'}`)" />
                            {{ skill.name }}
                        </span>
                        <span v-if="skill.description" class="skill-desc">{{ skill.description }}</span>
                    </div>
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.skill-list {
    flex: 1;
    overflow-y: auto;
    padding: calc(8px * var(--spacing-scale, 1));
}

.skill-empty {
    padding: calc(24px * var(--spacing-scale, 1)) calc(16px * var(--spacing-scale, 1));
    font-size: calc(var(--font-size-base, 14px) * 13 / 14);
    color: $text-muted;
    text-align: center;
}

.skill-category {
    margin-bottom: 4px;
}

.category-header {
    display: flex;
    align-items: center;
    gap: calc(6px * var(--spacing-scale, 1));
    width: 100%;
    padding: calc(6px * var(--spacing-scale, 1)) calc(10px * var(--spacing-scale, 1));
    border: none;
    background: none;
    color: $text-secondary;
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    cursor: pointer;
    border-radius: $radius-sm;

    &:hover {
        background: rgba(var(--accent-primary-rgb), 0.04);
    }

    &.sub {
        padding-inline-start: calc(22px * var(--spacing-scale, 1));
        font-size: calc(var(--font-size-base, 14px) * 11 / 14);
        text-transform: none;
        letter-spacing: 0;
    }
}

// External-filter path group (outer level)
.skill-path-group {
    margin-bottom: 8px;
}

.path-header {
    display: flex;
    align-items: center;
    gap: calc(6px * var(--spacing-scale, 1));
    width: 100%;
    padding: calc(6px * var(--spacing-scale, 1)) calc(10px * var(--spacing-scale, 1));
    border: none;
    background: none;
    color: #f59e0b;
    font-size: calc(var(--font-size-base, 14px) * 11 / 14);
    font-weight: 600;
    cursor: pointer;
    border-radius: $radius-sm;
    text-align: start;

    &:hover {
        background: rgba(245, 158, 11, 0.08);
    }
}

.path-header-icon {
    display: inline-flex;
    flex-shrink: 0;
    color: #f59e0b;
}

.path-header-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    direction: rtl;
    text-align: end;
}

.path-group-body {
    padding-inline-start: calc(4px * var(--spacing-scale, 1));
}

.category-arrow {
    flex-shrink: 0;
    transition: transform $transition-fast;

    &.collapsed {
        transform: rotate(-90deg);
    }
}

.category-name {
    flex: 1;
    text-align: start;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.category-count {
    font-size: calc(var(--font-size-base, 14px) * 11 / 14);
    color: $text-muted;
    background: rgba(var(--accent-primary-rgb), 0.06);
    padding: calc(1px * var(--spacing-scale, 1)) calc(6px * var(--spacing-scale, 1));
    border-radius: var(--radius-component, 8px);
}

.category-skills {
    padding: calc(2px * var(--spacing-scale, 1)) 0 calc(4px * var(--spacing-scale, 1));
}

.skill-item {
    display: flex;
    flex-direction: row;
    align-items: center;
    width: 100%;
    padding: calc(6px * var(--spacing-scale, 1)) calc(10px * var(--spacing-scale, 1)) calc(6px * var(--spacing-scale, 1)) calc(28px * var(--spacing-scale, 1));
    border: none;
    background: none;
    color: $text-secondary;
    font-size: calc(var(--font-size-base, 14px) * 13 / 14);
    text-align: start;
    cursor: pointer;
    border-radius: $radius-sm;
    transition: all $transition-fast;
    gap: calc(8px * var(--spacing-scale, 1));

    &:hover {
        background: rgba(var(--accent-primary-rgb), 0.06);
        color: $text-primary;
    }

    &.active {
        background: rgba(var(--accent-primary-rgb), 0.1);
        color: $text-primary;
        font-weight: 500;
    }
}

// Source indicator dot
.source-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-inline-end: 6px;
    flex-shrink: 0;
    vertical-align: middle;
}

.dot-builtin {
    background: #888;
}

.dot-hub {
    background: #4a90d9;
}

.dot-local {
    background: #66bb6a;
}

.dot-external {
    background: #f59e0b;
}

.skill-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
}

.skill-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.modified-badge {
    font-size: calc(var(--font-size-base, 14px) * 11 / 14);
    color: $warning;
    margin-inline-start: 2px;
    opacity: 0.7;
}

.skill-desc {
    font-size: calc(var(--font-size-base, 14px) * 11 / 14);
    color: $text-muted;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 1px;
}

.archive-section {
    margin-top: 12px;
    padding-top: calc(8px * var(--spacing-scale, 1));
    border-top: var(--border-width, 1px) solid $border-color;
}

.archive-header {
    color: $text-muted;
}

.skill-archived {
    opacity: 0.6;
    padding-inline-start: calc(28px * var(--spacing-scale, 1));
}

.skill-action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border: none;
    background: transparent;
    color: $text-muted;
    border-radius: $radius-sm;
    cursor: pointer;
    padding: 0;
    transition: background $transition-fast, color $transition-fast;

    &:hover:not(:disabled) {
        background: rgba(220, 38, 38, 0.12);
        color: #dc2626;
    }

    &:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }
}
</style>
