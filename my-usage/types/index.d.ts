/** One rate-limit window of the subscription, as the last API response reported it. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'my-usage': {
      limits: Limit[]
      tick: number
      /** Whether Claude tells, out loud, what it did after each turn. */
      isEnabled: boolean
      /** What this session is saying, null when it is not. */
      speech: { waiting: number } | null
      /** Animation step of the speaker icon while it speaks. */
      sweepStep: number
    }
  }
}
