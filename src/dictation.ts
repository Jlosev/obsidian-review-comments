import { Notice, Platform, requestUrl, setIcon } from "obsidian";
import type ReviewCommentsPlugin from "./main";

/**
 * 音声入力。押している間ではなく、押して開始、もう一度押して確定する形にする。
 * 長押しはコメント欄のスペースと衝突するため使わない。
 *
 * 既定は内蔵の音声認識で、費用もかからず宛先の設定も要らない。設定で別の宛先を
 * 選んだときだけ、録音を端末の外へ送る。
 */
/** 文字起こしの多くが受け取れる形に揃える。16kHz のモノラル */
const SAMPLE_RATE = 16000;

/** Float32 の並びを 16bit の WAV にする */
function toWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };

  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let at = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(at, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    at += 2;
  }
  return buffer;
}

class DictationSession {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private frames: Float32Array[] = [];
  private recording = false;

  constructor(
    private readonly plugin: ReviewCommentsPlugin,
    private readonly textarea: HTMLTextAreaElement,
    private readonly button: HTMLButtonElement
  ) {}

  get isRecording(): boolean {
    return this.recording;
  }

  async start(): Promise<void> {
    await this.startRecording();
  }

  /**
   * 録音して宛先へ送る。鍵は要求しない。端末の中で動く文字起こしを宛先にすると
   * 鍵が無く、そこを必須にすると使えなくなる
   */
  private async startRecording(): Promise<void> {
    const { i18n } = this.plugin;
    if (!this.plugin.settings.dictationEndpoint.trim()) {
      new Notice(i18n.t("notice.dictationNoKey"));
      return;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      new Notice(i18n.t("notice.dictationNoMic"));
      return;
    }

    this.frames = [];
    // 文字起こしの入口は WAV を前提にしているものが多い。MediaRecorder が返す
    // webm ではなく、生の標本を集めて自分で WAV に組む
    this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.processor.addEventListener("audioprocess", (e) => {
      if (!this.recording) return;
      this.frames.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    });
    source.connect(this.processor);
    this.processor.connect(this.context.destination);

    this.recording = true;
    this.setButtonState("recording");
  }

  /** 止めて文字にする。返るのは入力欄へ入れ終わったあと */
  async stopAndInsert(): Promise<void> {
    if (!this.recording) return;
    this.recording = false;

    const sampleRate = this.context?.sampleRate ?? SAMPLE_RATE;
    this.teardown();

    const total = this.frames.reduce((sum, f) => sum + f.length, 0);
    const samples = new Float32Array(total);
    let at = 0;
    for (const frame of this.frames) {
      samples.set(frame, at);
      at += frame.length;
    }
    this.frames = [];

    if (total === 0) {
      this.setButtonState("idle");
      return;
    }

    this.setButtonState("transcribing");
    try {
      const text = await transcribe(this.plugin, toWav(samples, sampleRate));
      if (text) insertAtCursor(this.textarea, text);
    } catch (e) {
      new Notice(
        this.plugin.i18n.t("notice.dictationFailed", {
          message: e instanceof Error ? e.message : String(e),
        })
      );
    } finally {
      this.setButtonState("idle");
    }
  }

  cancel() {
    this.recording = false;
    this.teardown();
    this.frames = [];
  }

  private teardown() {
    this.processor?.disconnect();
    this.processor = null;
    void this.context?.close();
    this.context = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  private setButtonState(state: "idle" | "recording" | "transcribing") {
    const { i18n } = this.plugin;
    this.button.toggleClass("is-recording", state === "recording");
    this.button.disabled = state === "transcribing";
    setIcon(this.button, state === "recording" ? "square" : "mic");
    this.button.setAttr(
      "aria-label",
      i18n.t(
        state === "recording"
          ? "dictation.stop"
          : state === "transcribing"
            ? "dictation.transcribing"
            : "dictation.start"
      )
    );
  }
}

/** カーソルの位置へ差し込む。選択されているときはそこを置き換える */
function insertAtCursor(textarea: HTMLTextAreaElement, text: string) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  // 前の文字と続けて書かれないよう、必要なときだけ空白を挟む
  const needsSpace = before.length > 0 && !/\s$/.test(before);
  const inserted = (needsSpace ? " " : "") + text;
  textarea.value = before + inserted + after;
  const caret = before.length + inserted.length;
  textarea.setSelectionRange(caret, caret);
  textarea.focus();
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** multipart/form-data を組み立てる。requestUrl は FormData を受け取れない */
function buildMultipart(
  boundary: string,
  audio: Uint8Array,
  fields: Record<string, string>,
  filename: string,
  audioType: string
): ArrayBuffer {
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  }
  parts.push(
    encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${audioType}\r\n\r\n`
    )
  );
  parts.push(audio);
  parts.push(encode(`\r\n--${boundary}--\r\n`));

  const size = parts.reduce((sum, p) => sum + p.length, 0);
  const body = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.length;
  }
  return body.buffer;
}

async function transcribe(
  plugin: ReviewCommentsPlugin,
  wav: ArrayBuffer
): Promise<string> {
  const { dictationApiKey, dictationEndpoint, dictationModel } =
    plugin.settings;
  const headers: Record<string, string> = {};
  if (dictationApiKey.trim()) {
    headers.Authorization = `Bearer ${dictationApiKey.trim()}`;
  }
  const fields: Record<string, string> = {};
  if (dictationModel.trim()) fields.model = dictationModel.trim();
  const boundary = `----ReviewComments${Date.now().toString(36)}`;
  const audio = new Uint8Array(wav);

  const response = await requestUrl({
    url: dictationEndpoint,
    method: "POST",
    contentType: `multipart/form-data; boundary=${boundary}`,
    headers,
    body: buildMultipart(
      boundary,
      audio,
      fields,
      "comment.wav",
      "audio/wav"
    ),
    throw: false,
  });

  if (response.status >= 400) {
    throw new Error(`${response.status} ${response.text.slice(0, 200)}`);
  }
  const text = (response.json?.text ?? "") as string;
  return text.trim();
}

/**
 * 入力欄の隣へマイクのボタンを足す。録音できない環境では何も足さない
 */
export function attachDictationButton(
  container: HTMLElement,
  textarea: HTMLTextAreaElement,
  plugin: ReviewCommentsPlugin
): () => void {
  const mode = plugin.settings.dictationMode;
  if (mode === "off") return () => undefined;
  // モバイルの一部と、マイクを持たない環境では録音そのものができない
  if (!Platform.isDesktop && !navigator.mediaDevices) return () => undefined;

  const button = container.createEl("button", {
    cls: "review-comment-dictation-btn",
    attr: { type: "button", "aria-label": plugin.i18n.t("dictation.start") },
  });
  setIcon(button, "mic");

  const session = new DictationSession(plugin, textarea, button);
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (session.isRecording) {
      void session.stopAndInsert();
    } else {
      void session.start();
    }
  });

  return () => session.cancel();
}
