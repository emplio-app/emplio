"use client";

import { MicIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { Spinner } from "@/components/ui/spinner";
import { API_URL } from "@/lib/api";

// Sarvam's quick endpoint rejects audio over 30s, so long notes are recorded as back-to-back
// pieces and transcribed separately.
// ponytail: a word can split at a piece boundary; move to Sarvam's batch API if that bites
const MAX_SECONDS = 120;
const PIECE_SECONDS = 25;

// seconds: how long the piece is, which is what Sarvam charges by
export async function transcribe(audio: Blob, seconds: number): Promise<string> {
  const res = await fetch(`${API_URL}/transcribe`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/octet-stream", "x-file-type": audio.type, "x-audio-seconds": String(Math.ceil(seconds)) },
    body: audio,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data.text;
}

type State = "idle" | "recording" | "transcribing";

// A reply note (quote.tsx) the cursor was in when recording started: the words go there, not the main box. It's a
// React-controlled field, so the value is set the way typing sets it, and its own onChange picks it up.
const noteInFocus = () => {
  const el = document.activeElement;
  return el instanceof HTMLTextAreaElement && el.dataset.quoteNote !== undefined ? el : null;
};
function typeInto(el: HTMLTextAreaElement, text: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, [el.value.trim(), text].filter(Boolean).join(" "));
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
}

export function VoiceInput({ onText }: { onText: (text: string) => void }) {
  const [state, setState] = useState<State>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (state !== "recording") return;
    const started = Date.now();
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS) stopRef.current?.();
    }, 250);
    return () => clearInterval(timer);
  }, [state]);

  // stop the mic if the composer unmounts mid-recording
  useEffect(() => () => stopRef.current?.(), []);

  async function start() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      // browsers hide the mic on plain http pages (a phone on the wifi); otherwise the browser or app has no mic access
      setError(
        window.isSecureContext
          ? "Voice can't start here. Update the Emplio app, or try Chrome or Safari"
          : "Voice needs a secure (https) page. Open Emplio from its https address",
      );
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone access was blocked");
      return;
    }
    const note = noteInFocus();
    const pieces: Promise<string>[] = [];
    let stopping = false;
    let rotate: ReturnType<typeof setTimeout>;

    // each piece is its own recorder, so every upload is a complete, playable file
    const recordPiece = () => {
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      const began = Date.now();
      let done!: (text: string) => void;
      pieces.push(new Promise<string>((r) => (done = r)));
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        const audio = new Blob(chunks, { type: rec.mimeType });
        const text = audio.size ? transcribe(audio, (Date.now() - began) / 1000) : Promise.resolve("");
        text.then(done, (e) => {
          done("");
          setError(e instanceof Error && e.message ? e.message : "Couldn't transcribe that, try again");
        });
        if (!stopping) recordPiece();
        else finish();
      };
      rec.start();
      rotate = setTimeout(() => rec.state === "recording" && rec.stop(), PIECE_SECONDS * 1000);
      stopRef.current = () => {
        stopping = true;
        clearTimeout(rotate);
        if (rec.state === "recording") rec.stop();
      };
    };

    const finish = async () => {
      stream.getTracks().forEach((t) => t.stop());
      stopRef.current = null;
      setState("transcribing");
      const text = (await Promise.all(pieces)).filter(Boolean).join(" ");
      if (text && note?.isConnected) typeInto(note, text);
      else if (text) onText(text);
      else setError((e) => e ?? "Didn't catch anything, try again");
      setState("idle");
    };

    recordPiece();
    setSeconds(0);
    setState("recording");
  }

  if (state === "recording")
    return (
      <PromptInputButton
        tooltip="Stop and transcribe"
        aria-label="Stop recording"
        onClick={() => stopRef.current?.()}
        className="gap-1.5 rounded-full bg-destructive/10 px-2.5 text-destructive hover:bg-destructive/15 hover:text-destructive"
      >
        <span className="size-2 animate-pulse rounded-full bg-destructive" />
        <span className="text-xs tabular-nums">
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </span>
        <SquareIcon className="size-3 fill-current" />
      </PromptInputButton>
    );

  return (
    <>
      <PromptInputButton
        tooltip={state === "transcribing" ? "Transcribing…" : "Speak your message"}
        aria-label="Record voice message"
        aria-disabled={state === "transcribing"}
        onClick={() => state === "idle" && start()}
        className="rounded-full text-muted-foreground"
      >
        {state === "transcribing" ? <Spinner className="size-4" /> : <MicIcon className="size-4" />}
      </PromptInputButton>
      {error && <span className="pl-1 text-xs text-destructive">{error}</span>}
    </>
  );
}
