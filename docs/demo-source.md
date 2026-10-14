# Current source-service demonstration

The final video uses one continuous browser screencast of the real local source service, followed by the retained production verification report. It has no cuts or scene retiming. Raw CDP frames retain their actual capture times; a native macOS renderer encodes a five-frame-per-second H.264 timeline and adds captions and locally synthesized narration. No browser or FFmpeg download is required.

The source application, PostgreSQL and browser actions are real. Fixture credentials are local. The final report is explicitly identified as retained production evidence. This video is not a cloud load benchmark.

## Reproduce

Use the pinned Node/pnpm toolchain, PostgreSQL, an installed Brave browser, Python 3 and macOS Swift/AVFoundation. No paid API is called by this local demonstration.

```sh
node --import tsx scripts/demo-continuous.ts --quick
```

This preflight exercises all actions without recording or long narration pauses. To verify capture and encoding with a short local run:

```sh
SQUALI_DEMO_DIR=work/continuous-format SQUALI_DEMO_CAPTURE=1 node --import tsx scripts/demo-continuous.ts --quick
swift scripts/render-continuous.swift work/continuous-format work/continuous-format/format-check.mp4
```

A quick format probe is not the final competition video. For the final continuous recording, first finish the independent private import verifier and save its successful report as `docs/evidence/2026-10-15-source/private-verification.json`:

```sh
node --import tsx scripts/demo-continuous.ts
swift scripts/render-continuous.swift work/continuous-demo work/continuous-demo/squali-source-demo.mp4
```

The recorder refuses a final run without a complete production report and native fsck. It synthesizes English narration with the installed Samantha voice, measures its duration and reserves scene time before capture. The renderer checks a 5–10 minute successful capture, continuous timestamps and narration fit. The result includes a machine-readable report and five decoded frames for visual verification. Inspect the final video and audio before publishing it.

`SQUALI_DEMO_DIR`, `SQUALI_PRIVATE_PROOF` and `SQUALI_BROWSER` override the output directory, accepted report and existing browser executable. Keep failure and preflight reports separate from the final recording. Source narration: [demo-source-script.json](demo-source-script.json).
