# Replacing the mobile recogniser

**Status:** proposal. Nothing here is built. Written 28 September 2026.

## Why this exists

Mobile voice works, but the phone plays a tone every time it stops hearing
sound. It is loud enough to read as "the microphone has stopped", and it is
not: recording carries on and transcription is fine.

It has been chased down properly, and the short version is that there is
nothing left to try inside the Web Speech API.

| Checked | Result |
| --- | --- |
| Is Life OS playing it? | **No.** No `Audio`, no media element, no oscillator, no notification, nothing connected to `AudioContext.destination`. A test asserts this across every file in `web/`. |
| Our own stop/restart churn | `teardown()` aborted a recogniser that had already ended, on every restart — two native transitions per pause. **Fixed**; now one. |
| `continuous = true` | Already set. Android ends the recognition on silence regardless. |
| Duplicate restart paths | None. One `end` produces exactly one restart, one recogniser is ever live. Tested by counting calls. |
| Silence watchdog | Off for mobile (`autoStop: false`), so nothing app-side ends a recording. |
| On-device recognition | **Desktop only.** MDN compat: `available()`, `install()` and `processLocally` are Chrome 139 on desktop, `false` on Chrome Android, WebView Android and Safari iOS. Confirmed on the handset: the offer stayed hidden because the API does not exist. |

The tone belongs to Android's speech service and fires when recognition
starts. Recognition has to restart after every pause because the engine ends
itself. There is no web-level control over either half.

**So the only way to stop it is to stop using the platform recogniser.**

## What would change

Record the audio ourselves and transcribe it server-side.

```
today:  tap → SpeechRecognition → [ends on pause → restart → TONE] → text
                                   ^ repeats for the whole recording

proposed: tap → MediaRecorder captures continuously → Keep/Send
                → upload → transcribe → text
```

No recogniser, so no tone, no restarts, and no seam-stitching between
restarts. The recording genuinely runs until Cancel, Keep or Send — which is
the contract we wrote and could not quite deliver.

### What gets better beyond the tone

- **The orb finally reacts to the voice.** It is currently driven by
  recognition *energy* because a second `getUserMedia` competed with the
  recogniser and took the microphone off it. With no recogniser there is no
  competition, so the orb can read real amplitude — the thing originally
  asked for and refused on safety grounds.
- **A lot of hard-won complexity stops being needed on mobile:** restart
  handling, `trimOverlap` at the seams, unsettled-word harvesting, the
  stale-recogniser guards. All of it exists to paper over a recogniser that
  keeps dying. It stays for desktop.
- **Accuracy.** Whisper-class models are generally better than Android's
  recogniser, particularly on names and South African place names.

### What gets worse

- **Latency.** Today Keep shows text instantly, because the recogniser has
  been transcribing all along. Uploading and transcribing a 20-second clip is
  roughly 1–3 seconds of waiting. This is the real cost and it is felt on
  every single use.
- **The voice leaves the phone.** Today, audio goes to Google's speech
  service; after this it goes to ours and then a transcription provider. That
  is not obviously worse, but it is *our* choice now and testers must be told
  plainly.
- **No transcription without a signal.** Android's recogniser can fall back
  to an installed offline pack; an upload cannot.
- **Money**, below.

## Cost

Per minute of recorded speech, September 2026 list prices:

| Provider | Model | Per minute | Notes |
| --- | --- | --- | --- |
| AssemblyAI | Universal-2 (async) | **$0.0025** | Cheapest credible; 99 languages |
| OpenAI | gpt-4o-mini-transcribe | **$0.003** | Simplest API, one key |
| Deepgram | Nova-3 (batch) | $0.0043 | $0.0077 streaming |
| Google | Chirp v2 | $0.016 | $0.004 on a 24-hour batch tier |

At $0.003/min, somebody dictating five minutes a day costs **about $0.45 a
month**. Twelve beta testers at that rate is **~$5.40 a month**. This is not
the expensive part of the product — a single assistant turn costs more than a
minute of transcription.

The published rate is the floor, not the bill: add-ons such as diarization or
word timestamps multiply it, and we need none of them.

### It must go through the existing meter

Transcription is spend, so it goes through `api/src/usage/` like every model
call — priced server-side, written to the ledger, counted against
`DEFAULT_BETA_ALLOWANCE_USD`. The browser never learns the rate and never
decides whether a recording is affordable. Same rule as the assistant.

## Shape of the work

1. **Client capture.** `MediaRecorder` on the existing stream. Android Chrome
   gives `audio/webm;codecs=opus`; Safari gives `audio/mp4`, so the mime type
   is negotiated rather than assumed. Cancel discards the blob and uploads
   nothing.
2. **Upload.** A new authenticated route, multipart, with a hard size cap.
   Fastify's `bodyLimit` is currently 8 MB — Opus at 24 kbps is about 180 KB a
   minute, so 8 MB is roughly 45 minutes and the existing limit is already
   generous. The five-minute safety stop bounds it anyway.
3. **Transcribe.** Provider key server-side only, alongside the existing
   secrets. Never reaches the browser.
4. **Meter it.** Duration × rate → the ledger, before the text comes back.
5. **Return the text** as the segment. `ComposerVoice` is unchanged: base +
   segment, Cancel/Keep/Send exactly as now. The state contract does not move.
6. **Orb from real amplitude**, via the analyser that is now free to run.
7. **Desktop untouched.** Web Speech stays there: it streams, it is free, and
   it makes no noise on a laptop.

Mobile keeps Web Speech as a fallback when the upload fails, so a bad signal
degrades to today's behaviour rather than to nothing.

### Risks

- **Latency is the one that could sink it.** Worth building the upload path
  first and measuring a real round trip from a phone on mobile data before
  committing to the rest.
- Audio retention: the blob should be transcribed and dropped, never stored,
  and that should be true in the code rather than in a promise.
- A second vendor to depend on, with its own outage modes.
- iOS is untested here and its `MediaRecorder` mime types differ.

## Recommendation

Build the upload-and-transcribe path behind a flag, measure the real round
trip on a phone, and only then decide. If a 20-second clip comes back in
under two seconds this is clearly worth it; if it takes five, the tone may be
the lesser evil and that is worth knowing before the rest is built.

Provider: **OpenAI gpt-4o-mini-transcribe** to start — one key, one endpoint,
$0.003/min, and swapping later is a single module. AssemblyAI is cheaper and
worth revisiting if volume ever justifies the second integration.
