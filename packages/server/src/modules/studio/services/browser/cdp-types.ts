/**
 * Minimal CDP surface used by this feature (spec-03).
 *
 * Only the fields we actually read are declared — this is deliberately *not* a
 * copy of the DevTools schema. Domains: Target, Page, Runtime, DOM,
 * Accessibility, Input, Network, Inspector.
 */

export interface CdpTargetInfo {
  targetId: string
  type: string
  title: string
  url: string
  browserContextId?: string
  attached?: boolean
  openerId?: string
}

export interface CdpTargetCreatedEvent {
  targetInfo: CdpTargetInfo
}

export interface CdpTargetInfoChangedEvent {
  targetInfo: CdpTargetInfo
}

export interface CdpTargetDestroyedEvent {
  targetId: string
}

export interface CdpAttachedToTargetEvent {
  sessionId: string
  targetInfo: CdpTargetInfo
  waitingForDebugger: boolean
}

export interface CdpDetachedFromTargetEvent {
  sessionId: string
  targetId?: string
}

export interface CdpFrameNavigatedEvent {
  frame: {
    id: string
    parentId?: string
    url: string
    loaderId?: string
    securityOrigin?: string
    mimeType?: string
  }
  type: string
}

export interface CdpFrameStartedLoadingEvent {
  frameId: string
}

export interface CdpFrameStoppedLoadingEvent {
  frameId: string
}

export interface CdpTargetCrashedEvent {
  status: string
  errorCode: number
}

export interface CdpNavigationEntry {
  id: number
  url: string
  userTypedURL: string
  title: string
  transitionType: string
}

export interface CdpNavigationHistoryResult {
  currentIndex: number
  entries: CdpNavigationEntry[]
}

export interface CdpRuntimeConsoleEvent {
  type: string
  args: Array<{ type: string, value?: unknown, description?: string }>
  executionContextId: number
  timestamp: number
  stackTrace?: { callFrames?: Array<{ functionName: string, url: string, lineNumber: number }> }
}

export interface CdpRuntimeExceptionEvent {
  exceptionDetails: {
    text: string
    url?: string
    lineNumber?: number
    exception?: { description?: string, value?: unknown }
  }
}

export interface CdpNode {
  nodeId: number
  backendNodeId: number
  nodeType: number
  nodeName: string
  nodeValue: string
}

export interface CdpAXNodeProperty {
  name: string
  value?: { type?: string, value?: unknown }
}

export interface CdpAXNode {
  nodeId: string
  ignored: boolean
  role?: { type?: string, value?: string }
  name?: { type?: string, value?: string }
  value?: { type?: string, value?: unknown }
  description?: { type?: string, value?: string }
  properties?: CdpAXNodeProperty[]
  backendDOMNodeId?: number
}
