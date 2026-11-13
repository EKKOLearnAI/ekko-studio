export type GroupChatRuntimeServer = any

let runtimeServer: GroupChatRuntimeServer | null = null

export function setGroupChatRuntimeServer(server: GroupChatRuntimeServer | null): void {
    runtimeServer = server
}

export function getGroupChatRuntimeServer(): GroupChatRuntimeServer | null {
    return runtimeServer
}
