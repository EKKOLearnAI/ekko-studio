# Plugin video fixture

`plugin-video.mp4` is a synthetic two-second, 160×90 blue video with a 440 Hz audio
track. H.264 baseline / yuv420p and AAC cover video decoding and the difference
between muted and audible autoplay. No external media or provider is used.
The browser tests use the checked-in file and do not require FFmpeg.

Regenerate from the repository root with FFmpeg (remove only this fixture first):

```sh
ffmpeg -n -f lavfi -i color=c=blue:s=160x90:r=12:d=2 -f lavfi -i sine=frequency=440:sample_rate=16000:duration=2 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -preset veryfast -c:a aac -b:a 32k -ac 1 -shortest -movflags +faststart tests/e2e/fixtures/plugin-video.mp4
```
