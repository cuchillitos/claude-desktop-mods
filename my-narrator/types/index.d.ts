declare module 'claude-code' {
  interface PluginState {
    'my-narrator': {
      /** Whether Claude tells, out loud, what it did after each turn. */
      isEnabled: boolean
      /** What this session is saying, null when it is not. */
      speech: { waiting: number } | null
      /** Animation step of the speaker icon while it speaks. */
      sweepStep: number
    }
  }
}
