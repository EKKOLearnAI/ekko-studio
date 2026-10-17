import { ref } from 'vue'

// MCP/Skills 管理页的“管理目标”profile。
// null 表示跟随全局激活 profile（请求依赖 X-Hermes-Profile 头，行为与
// 引入本 composable 之前完全一致）；指定名字时，仅管理页的配置读写改为
// 该 profile —— 不切换会话激活 profile、不刷新应用。
// 只保存在内存里，刷新页面后回到“跟随激活 profile”。
const managedProfile = ref<string | null>(null)

export function useManagedProfileScope() {
  return { managedProfile }
}
