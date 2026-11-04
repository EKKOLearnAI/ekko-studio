# Person animation assets

The navigation rail loops the original character's `idle.gif`; it does not switch
artwork or restart animations in response to account activity or outcomes.
The shared presence connection still supplies background-task counts.

Supplied by the user from `Zhezhe_GIF_Pack/240` (27 October 2026).
These are unmodified 240 × 240 transparent GIFs, with 40 ms frame delays and
infinite looping. File names map to the source pack as follows:

| Asset | Source | Frames | Loop duration |
| --- | --- | --- | --- |
| idle.gif | 01_idle.gif | 70 | 2.8 s |
| thinking.gif | 02_thinking.gif | 60 | 2.4 s |
| searching.gif | 03_searching.gif | 60 | 2.4 s |
| done.gif | 04_done.gif | 50 | 2.0 s |
| error.gif | 05_error.gif | 75 | 3.0 s |
| sleeping.gif | 06_sleep.gif | 80 | 3.2 s |

Completion and error feedback is shown for one loop (2 and 3 seconds), then
returns to the current working, idle or sleeping state. The server owns this
deadline across devices. All six assets share the same square framing and total
about 2.7 MB.

## Additional characters

Supplied by the user from `折折6动作GIF_10只_360` (29 October 2026).
The `xiaohe`, `dachu`, `nuannuan`, `yingying`, `shuishui`, `xiaofei`, `youchai`,
`erji`, `xingxing` and `paidui` directories contain the original 360 × 360
transparent GIFs. Source actions 01–06 map to `idle`, `thinking`, `searching`,
`done`, `error` and `sleeping`, respectively. Animation files are copied unchanged.

Each character, including the original character in this directory, has an
`idle.png` extracted from page 0 of `idle.gif` as RGBA, without compositing a
background. These original canvases have asymmetric transparent padding. The
catalog records each additional character's visible alpha-bound center. Static
chat and session-list avatars use object positioning to center the artwork
inside their white rounded boxes without moving the box or modifying pixels.
Working avatars use a separate offset measured over all 60 thinking frames,
keeping the entire animated range inside the same box without per-frame jumps.
The original character, picker and GIF playback keep their approved framing.
The Bot picker repeats the characters in a horizontal carousel,
recentering its copies at either end for continuous scrolling. Wheel, mouse drag,
native touch scrolling, click and arrow keys select the centered character.
Only the selected character grows and plays its idle GIF; hovering does not
change its scale or playback. Scrolling stops at the user's chosen offset,
without snapping to a character. Other characters show their first frame.
Chinese interfaces show Chinese names; other interfaces show pinyin.
Reduced-motion preferences keep the still visible.
Hitting a character fills the Bot name with its localized label; users can still
edit it. Creating the conversation reuses the single-chat deployment lifecycle,
capturing only the transparent character image and landing it on that Bot's
thinking avatar. A failed creation keeps the draft and does not start deployment.
Character identities, stills and action paths are registered in
`packages/shared/person-bots.ts`.
