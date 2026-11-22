# Claude desktop mods

One small mod for Claude Code that draws a single band above the prompt, built for the desktop app (it falls back to a text layout in the terminal).

- **Usage bars**: your 5-hour and weekly subscription usage as two rounded bars. Green below 60% used, yellow from 60%, red from 85%. The percentage sits inside each bar and the reset countdown beside it.
- **Narrator**: a small speaker icon in the middle of the band. When on (green), Claude reads aloud a summary of each answer, in under 100 words, in the language you wrote in (English, French, Spanish and more). Uses the best system voice installed: macOS, Windows and Linux (speech-dispatcher / espeak-ng). One extra Haiku call per turn, only while on. Commands: `/narrator on | off | stop | voices | test [voice]`.

Both live in one plugin, `my-usage`, so they share one line. (The narrator used to be a separate `my-narrator` plugin; the engine draws one row per plugin, which made two lines. Uninstall it.)

## Install

In a terminal session of Claude Code:

```
/plugin marketplace add cuchillitos/claude-desktop-mods
/plugin install my-usage@claude-desktop-mods
```

From a shell:

```
claude plugin marketplace add cuchillitos/claude-desktop-mods
claude plugin install my-usage@claude-desktop-mods
```

Choose the user scope to have it in every session; it then loads in the desktop app's Code tab too. In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `cuchillitos/claude-desktop-mods`, then Add plugin.

## Credits

Adapted from `sub-meter` and `narrator` in [midudev/better-claude](https://github.com/midudev/better-claude) (MIT). Licensed MIT.
