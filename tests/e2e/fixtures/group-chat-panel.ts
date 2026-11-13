import { h } from 'vue'

export default { setup: () => () => h('section', { 'data-testid': 'group-panel' }, 'Existing group chat') }
