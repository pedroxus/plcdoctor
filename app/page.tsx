"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { marked } from "marked";
import { extractInstructions, type Instruction } from "@/lib/instructions";
import { candidatesFor, fileHash, findExact, saveToHistory, type HistoryEntry } from "@/lib/history";
import PdfPreview from "./PdfPreview";

/* ---------- Tipos ---------- */

type ApiBlock = Record<string, unknown>;
interface ApiMessage {
  role: "user" | "assistant";
  content: ApiBlock[];
}

type StepState = "ok" | "no";
interface Check {
  s: StepState;
  t: string;
}

interface ChatItem {
  id: string;
  role: "user" | "assistant";
  text: string;
  note?: string;
  error?: boolean;
  // Fecha de la respuesta original cuando se ha reutilizado del histórico.
  fromHistory?: number;
  // Instrucciones creadas en esta respuesta, para la vista previa en el chat.
  downloadIds?: string[];
  // Pasos marcados por el técnico y lo que ya se le ha contado al agente.
  checks?: Record<string, Check>;
  reported?: Record<string, Check>;
}

type Kind = "pdf" | "image" | "text";
interface Attachment {
  id: string;
  name: string;
  kind: Kind;
  size: number;
  status: "uploading" | "ready" | "error";
  error?: string;
  fileId?: string;
  data?: string;
  mediaType?: string;
  text?: string;
  thumb?: string;
  hash?: string;
  sent: boolean;
}

interface State {
  chat: ChatItem[];
  api: ApiMessage[];
  attachments: Attachment[];
  removed: string[];
  downloads: Instruction[];
}

type Tab = "chat" | "adjuntos" | "descargables";

const EMPTY: State = { chat: [], api: [], attachments: [], removed: [], downloads: [] };
// La consulta vive solo en la pestaña abierta (sessionStorage): sobrevive a recargar
// la página, pero cada vez que se abre la app empieza una consulta limpia.
const STORAGE_KEY = "plcdoctor-consulta";
const OLD_STORAGE_KEY = "plcdoctor-consulta-v1";
const CODE_KEY = "plcdoctor-codigo";
const TEXT_EXT = ["scl", "xml", "st", "awl", "csv", "txt", "md", "log", "json", "udt", "db"];
const MAX_UPLOAD = 4 * 1024 * 1024;

const uid = () => Math.random().toString(36).slice(2, 10);

// Reconocimiento de voz del navegador (Web Speech API), con los tipos mínimos que se usan.
interface SpeechResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
interface SpeechRec {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecCtor = new () => SpeechRec;

function speechCtor(): SpeechRecCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecCtor; webkitSpeechRecognition?: SpeechRecCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/* ---------- Utilidades ---------- */

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    html(token) {
      return token.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
  },
});

function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string;
}

// Convierte cada elemento de las listas del agente en un paso que se puede marcar.
function withSteps(html: string, checks?: Record<string, Check>): string {
  let i = 0;
  return html.replace(/<li>/g, () => {
    const n = i++;
    const state = checks?.[n]?.s;
    return `<li data-step="${n}" class="step${state ? " " + state : ""}">`;
  });
}

// Lo que el técnico ha marcado o desmarcado desde su último mensaje, para que el agente lo tenga en cuenta.
function checkNotes(chat: ChatItem[]): string | null {
  const ok: string[] = [];
  const no: string[] = [];
  const undone: string[] = [];
  for (const m of chat) {
    for (const [n, c] of Object.entries(m.checks ?? {})) {
      if (m.reported?.[n]?.s !== c.s) (c.s === "ok" ? ok : no).push(c.t);
    }
    for (const [n, c] of Object.entries(m.reported ?? {})) {
      if (!m.checks?.[n]) undone.push(c.t);
    }
  }
  const parts: string[] = [];
  if (ok.length) parts.push(`revisado: ${ok.join(" | ")}`);
  if (no.length) parts.push(`descartado: ${no.join(" | ")}`);
  if (undone.length) parts.push(`desmarcado: ${undone.join(" | ")}`);
  return parts.length ? `[El técnico ha marcado en tus listas de pasos. ${parts.join(". ")}]` : null;
}

function kindOf(file: File): Kind | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (file.type === "application/pdf" || ext === "pdf") return "pdf";
  if (file.type.startsWith("image/")) return "image";
  if (TEXT_EXT.includes(ext) || file.type.startsWith("text/")) return "text";
  return null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Reduce las fotos del móvil a un tamaño razonable antes de subirlas.
async function shrinkImage(file: File, maxSide: number, quality = 0.85): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("No se pudo procesar la imagen"))), "image/jpeg", quality),
  );
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(blob);
  });
}

function attachmentBlocks(a: Attachment): ApiBlock[] {
  if (a.kind === "text") {
    return [{ type: "document", title: a.name, source: { type: "text", media_type: "text/plain", data: a.text ?? "" } }];
  }
  const source = a.fileId
    ? { type: "file", file_id: a.fileId }
    : { type: "base64", media_type: a.mediaType, data: a.data };
  if (a.kind === "pdf") {
    return [{ type: "document", title: a.name, source }];
  }
  return [{ type: "text", text: `Foto adjunta: ${a.name}` }, { type: "image", source }];
}

/* ---------- Iconos ---------- */

// Iconos duotono: línea más un relleno suave del mismo color (.s forma, .d detalle, .l solo línea).
const svgIcon = (body: React.ReactNode) => (
  <svg viewBox="0 0 24 24" className="ic" aria-hidden="true">{body}</svg>
);

const Icon = {
  chat: svgIcon(<><path className="s" d="M4 5.5A1.5 1.5 0 015.5 4h13A1.5 1.5 0 0120 5.5v9a1.5 1.5 0 01-1.5 1.5H9l-5 4V5.5z" /><path className="d" d="M8 9h8M8 12h5" /></>),
  clip: svgIcon(<path className="l" d="M20.5 11.5l-8.4 8.4a5 5 0 01-7.1-7.1l8.4-8.4a3.4 3.4 0 014.8 4.8l-8.4 8.4a1.7 1.7 0 01-2.4-2.4l7.7-7.7" />),
  download: svgIcon(<path className="l" d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5M4 15.5v3a2 2 0 002 2h12a2 2 0 002-2v-3" />),
  send: svgIcon(<><path className="s" d="M21.5 2.5L2.5 9.8l7.8 3.9 3.9 7.8Z" /><path className="d" d="M21.5 2.5l-11.2 11.2" /></>),
  camera: svgIcon(<><path className="s" d="M3 8.5a2 2 0 012-2h2.2l1.5-2h6.6l1.5 2H19a2 2 0 012 2V18a2 2 0 01-2 2H5a2 2 0 01-2-2Z" /><circle className="d" cx="12" cy="13" r="3.4" /></>),
  trash: svgIcon(<><path className="s" d="M6.5 7.5h11l-1 12a1.5 1.5 0 01-1.5 1.4H9a1.5 1.5 0 01-1.5-1.4l-1-12z" /><path className="l" d="M4.5 7.5h15M9.5 7.5V5a1 1 0 011-1h3a1 1 0 011 1v2.5" /><path className="d" d="M10.5 11v6M13.5 11v6" /></>),
  doc: svgIcon(<><path className="s" d="M6 2.5h8.5l5 5V20a1.5 1.5 0 01-1.5 1.5H6A1.5 1.5 0 014.5 20V4A1.5 1.5 0 016 2.5Z" /><path className="d" d="M14.5 2.5V7.5h5M8.5 12.5h7M8.5 16h5" /></>),
  code: svgIcon(<><path className="s" d="M6 2.5h8.5l5 5V20a1.5 1.5 0 01-1.5 1.5H6A1.5 1.5 0 014.5 20V4A1.5 1.5 0 016 2.5Z" /><path className="d" d="M14.5 2.5V7.5h5M10 12l-2 2 2 2M14 12l2 2-2 2" /></>),
  plus: svgIcon(<path className="l" d="M12 5v14M5 12h14" />),
  image: svgIcon(<><rect className="s" x="3" y="4" width="18" height="16" rx="2.2" /><circle className="d" cx="8.5" cy="9.5" r="1.6" /><path className="d" d="M20.5 15.5l-4.5-4.5L5.5 19.5" /></>),
  mic: svgIcon(<><rect className="s" x="9" y="3" width="6" height="11" rx="3" /><path className="l" d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21M8.5 21h7" /></>),
  history: svgIcon(<><circle className="f" cx="12" cy="12" r="8.5" /><path className="l" d="M3.5 12a8.5 8.5 0 102.5-6L3.5 8.5M3.5 4v4.5H8" /><path className="d" d="M12 7.5V12l3 2" /></>),
};

// Logo de PLCDoctor: el robot de mantenimiento con lupa. En la cabecera oscura va la versión clara.
function Logo({ size = "", dark = false }: { size?: string; dark?: boolean }) {
  return (
    <span className={`logo ${size}${dark ? " dark" : ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={dark ? "/plcdoctor_logo_oscuro.svg" : "/plcdoctor_logo.svg"} alt="PLCDoctor" />
    </span>
  );
}

/* ---------- Página ---------- */

export default function Home() {
  const [state, setState] = useState<State>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>("chat");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [streamStatus, setStreamStatus] = useState("");
  const [newDownloads, setNewDownloads] = useState(0);
  const [openInstruction, setOpenInstruction] = useState<string | null>(null);
  const [auth, setAuth] = useState<{ required: boolean; code: string; ok: boolean } | null>(null);
  const [attachMenu, setAttachMenu] = useState(false);
  const [speechOk, setSpeechOk] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [micError, setMicError] = useState("");

  const stateRef = useRef(state);
  stateRef.current = state;
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<SpeechRec | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* Carga inicial: conversación guardada y control de acceso */
  useEffect(() => {
    try {
      localStorage.removeItem(OLD_STORAGE_KEY);
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) {
        const s = JSON.parse(saved) as State;
        s.attachments = s.attachments.filter((a) => a.status === "ready");
        s.chat = s.chat.filter((m) => !m.error);
        setState(s);
      }
    } catch {}
    setLoaded(true);
    const code = (() => {
      try {
        return localStorage.getItem(CODE_KEY) ?? "";
      } catch {
        return "";
      }
    })();
    fetch("/api/auth")
      .then((r) => r.json())
      .then(async ({ required }: { required: boolean }) => {
        if (!required) return setAuth({ required, code: "", ok: true });
        if (!code) return setAuth({ required, code: "", ok: false });
        const r = await fetch("/api/auth", { method: "POST", headers: { "x-access-code": code } });
        setAuth({ required, code, ok: r.ok });
      })
      .catch(() => setAuth({ required: false, code: "", ok: true }));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {}
  }, [state, loaded]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [state.chat.length, streamText, streamStatus, tab]);

  useEffect(() => {
    if (tab === "descargables") setNewDownloads(0);
  }, [tab]);

  useEffect(() => {
    setSpeechOk(!!speechCtor());
    return () => recRef.current?.abort();
  }, []);

  // El cuadro de texto crece con lo que se escribe o se dicta.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  const headers = useCallback((): Record<string, string> => (auth?.code ? { "x-access-code": auth.code } : {}), [auth]);

  const patchAttachment = (id: string, patch: Partial<Attachment>) =>
    setState((s) => ({ ...s, attachments: s.attachments.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));

  /* ---------- Adjuntos ---------- */

  async function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    setAttachMenu(false);
    for (const file of Array.from(files)) {
      const kind = kindOf(file);
      const id = uid();
      const base: Attachment = { id, name: file.name, kind: kind ?? "text", size: file.size, status: "uploading", sent: false };
      if (!kind) {
        setState((s) => ({
          ...s,
          attachments: [...s.attachments, { ...base, status: "error", error: "Formato no admitido (PDF, imagen o texto de PLC)" }],
        }));
        continue;
      }
      setState((s) => ({ ...s, attachments: [...s.attachments, base] }));
      try {
        patchAttachment(id, { hash: await fileHash(file) });
        if (kind === "text") {
          if (file.size > 1024 * 1024) throw new Error("El archivo de texto supera 1 MB");
          patchAttachment(id, { text: await file.text(), status: "ready" });
          continue;
        }
        let blob: Blob = file;
        let name = file.name;
        if (kind === "image") {
          blob = await shrinkImage(file, 1568, 0.82);
          name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
          const thumb = await blobToDataUrl(await shrinkImage(file, 160, 0.7));
          patchAttachment(id, { thumb, name, size: blob.size });
        }
        if (blob.size > MAX_UPLOAD) throw new Error(`Supera el máximo de ${formatSize(MAX_UPLOAD)}`);
        const mediaType = kind === "pdf" ? "application/pdf" : "image/jpeg";
        const form = new FormData();
        form.append("file", new File([blob], name, { type: mediaType }));
        const res = await fetch("/api/upload", { method: "POST", body: form, headers: headers() });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.id) {
          patchAttachment(id, { fileId: data.id, status: "ready" });
        } else {
          if (res.status === 401) throw new Error(data.error ?? "Código de acceso incorrecto");
          // Si la Files API no está disponible, el archivo viaja incrustado en el mensaje.
          console.warn("Subida a la Files API fallida, se envía incrustado:", data.error);
          const base64 = (await blobToDataUrl(blob)).split(",")[1];
          patchAttachment(id, { data: base64, mediaType, status: "ready" });
        }
      } catch (err) {
        patchAttachment(id, { status: "error", error: err instanceof Error ? err.message : "Error" });
      }
    }
  }

  function removeAttachment(a: Attachment) {
    setState((s) => ({
      ...s,
      attachments: s.attachments.filter((x) => x.id !== a.id),
      removed: a.sent ? [...s.removed, a.name] : s.removed,
    }));
  }

  // Pegar una captura o una foto (Ctrl+V) en el cuadro de texto la añade a Adjuntos.
  function pasteFiles(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData.files);
    if (!files.length) return;
    e.preventDefault();
    const stamp = new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(/:/g, "");
    addFiles(
      files.map((f, i) =>
        f.type.startsWith("image/") && /^image\.\w+$/i.test(f.name)
          ? new File([f], `captura-${stamp}${i ? "-" + i : ""}.${f.name.split(".").pop()}`, { type: f.type })
          : f,
      ),
    );
  }

  /* ---------- Dictado ---------- */

  // El dictado se añade al cuadro de texto, donde se puede corregir antes de enviar.
  // Se puede escribir y dictar a la vez: cada frase reconocida se añade al final.
  function appendDictation(segment: string) {
    const t = segment.trim();
    if (!t) return;
    setInput((prev) => {
      const sep = prev && !/\s$/.test(prev) ? " " : "";
      const capital = !prev.trim() || /[.!?]\s*$/.test(prev);
      return prev + sep + (capital ? t[0].toUpperCase() + t.slice(1) : t);
    });
  }

  function toggleDictation() {
    if (recRef.current) {
      recRef.current.stop();
      return;
    }
    const Rec = speechCtor();
    if (!Rec) return;
    const rec = new Rec();
    rec.lang = "es-ES";
    rec.continuous = true;
    rec.interimResults = true;
    const done = new Set<number>();
    rec.onresult = (e) => {
      let pending = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          if (!done.has(i)) {
            done.add(i);
            appendDictation(r[0].transcript);
          }
        } else {
          pending += r[0].transcript;
        }
      }
      setInterim(pending);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") setMicError("Permite el uso del micrófono en el navegador para dictar.");
      else if (e.error !== "no-speech" && e.error !== "aborted") setMicError(`No se ha podido dictar (${e.error}).`);
    };
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
      setInterim("");
    };
    setMicError("");
    try {
      rec.start();
      recRef.current = rec;
      setListening(true);
    } catch {
      setMicError("No se ha podido activar el micrófono.");
    }
  }

  function stopDictation() {
    recRef.current?.abort();
    recRef.current = null;
    setListening(false);
    setInterim("");
  }

  /* ---------- Pasos marcables ---------- */

  // Un toque: revisado. Otro: descartado. Otro: sin marcar. El texto se tacha pero sigue legible.
  function toggleStep(itemId: string, e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (target.closest("a")) return;
    const li = target.closest<HTMLLIElement>("li[data-step]");
    if (!li?.dataset.step) return;
    const n = li.dataset.step;
    const clone = li.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("ul, ol").forEach((x) => x.remove());
    const t = (clone.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    setState((s) => ({
      ...s,
      chat: s.chat.map((m) => {
        if (m.id !== itemId) return m;
        const checks = { ...(m.checks ?? {}) };
        const cur = checks[n]?.s;
        const next: StepState | undefined = cur === undefined ? "ok" : cur === "ok" ? "no" : undefined;
        if (next) checks[n] = { s: next, t };
        else delete checks[n];
        return { ...m, checks };
      }),
    }));
  }

  /* ---------- Chat ---------- */

  // Llama al agente con la conversación y va mostrando la respuesta según llega.
  async function callAgent(api: ApiMessage[]): Promise<{ full: string; turns: ApiBlock[][] }> {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers() },
      body: JSON.stringify({ messages: api }),
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Error ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let turns: ApiBlock[][] | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.t === "text") {
          full += ev.d;
          setStreamText(full);
          setStreamStatus("");
        } else if (ev.t === "status") {
          setStreamStatus(ev.d);
        } else if (ev.t === "done") {
          turns = ev.turns;
        } else if (ev.t === "error") {
          throw new Error(ev.d);
        }
      }
    }
    if (!turns) throw new Error("La respuesta se cortó antes de terminar");
    return { full, turns };
  }

  // Añade la respuesta al chat y saca sus instrucciones a Descargables.
  function applyAnswer(full: string, turns: ApiBlock[][], fromHistory?: number) {
    const { visible, found } = extractInstructions(full);
    const now = Date.now();
    const newIns: Instruction[] = found.map((f, i) => ({ id: uid(), title: f.title, markdown: f.markdown, createdAt: now + i }));
    setState((cur) => ({
      ...cur,
      api: [...cur.api, ...turns.map((content) => ({ role: "assistant" as const, content }))],
      chat: [
        ...cur.chat,
        {
          id: uid(),
          role: "assistant",
          text: visible || (newIns.length ? "Instrucción creada." : "(sin respuesta)"),
          fromHistory,
          downloadIds: newIns.length ? newIns.map((d) => d.id) : undefined,
        },
      ],
      downloads: [...newIns, ...cur.downloads],
    }));
    if (newIns.length) setNewDownloads((n) => n + newIns.length);
  }

  // Busca la misma consulta en el histórico: primero idéntica y, si no, equivalente según el modelo.
  async function lookupHistory(question: string, files: string[]): Promise<HistoryEntry | null> {
    const exact = findExact(question, files);
    if (exact) return exact;
    const candidates = candidatesFor(files);
    if (!candidates.length) return null;
    setStreamStatus("Buscando en el histórico…");
    try {
      const res = await fetch("/api/similar", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers() },
        body: JSON.stringify({ question, candidates: candidates.map((c) => c.question) }),
      });
      const { match } = (await res.json()) as { match: number | null };
      return match === null ? null : (candidates[match] ?? null);
    } catch {
      return null;
    } finally {
      setStreamStatus("");
    }
  }

  async function send() {
    const s = stateRef.current;
    const text = input.trim();
    const pending = s.attachments.filter((a) => a.status === "ready" && !a.sent);
    if (busy || (!text && pending.length === 0)) return;
    if (s.attachments.some((a) => a.status === "uploading")) return;
    stopDictation();

    const notes: string[] = [];
    if (pending.length) notes.push(`[El técnico ha subido a Adjuntos: ${pending.map((a) => a.name).join(", ")}]`);
    if (s.removed.length) notes.push(`[El técnico ha quitado de Adjuntos: ${s.removed.join(", ")}]`);
    const checks = checkNotes(s.chat);
    if (checks) notes.push(checks);
    const onlyPhotos = pending.length > 0 && pending.every((a) => a.kind === "image");
    const userText =
      text || (onlyPhotos ? "Te paso una foto. Dime qué componente es y lo que veas relevante." : "He subido documentación nueva a Adjuntos.");

    const userMsg: ApiMessage = {
      role: "user",
      content: [...pending.flatMap(attachmentBlocks), { type: "text", text: [...notes, userText].join("\n\n") }],
    };
    const chatUser: ChatItem = {
      id: uid(),
      role: "user",
      text: userText,
      note: pending.length ? `Adjuntos: ${pending.map((a) => a.name).join(", ")}` : undefined,
    };
    const prev = s;
    const api = [...s.api, userMsg];
    const pendingIds = new Set(pending.map((a) => a.id));

    // El histórico solo se usa en la primera pregunta de la consulta, con los mismos adjuntos.
    const hashes = pending.map((a) => a.hash);
    const cacheable = s.chat.length === 0 && !!text && hashes.every(Boolean);

    setState({
      ...s,
      api,
      chat: [...s.chat.map((m) => (m.checks || m.reported ? { ...m, reported: m.checks } : m)), chatUser],
      removed: [],
      attachments: s.attachments.map((a) => (pendingIds.has(a.id) ? { ...a, sent: true } : a)),
    });
    setInput("");
    setBusy(true);
    setStreamText("");
    setStreamStatus("");

    try {
      const hit = cacheable ? await lookupHistory(text, hashes as string[]) : null;
      if (hit) {
        applyAnswer(hit.answer, [[{ type: "text", text: hit.answer }]], hit.createdAt);
      } else {
        const { full, turns } = await callAgent(api);
        applyAnswer(full, turns);
        if (cacheable) saveToHistory({ question: text, files: hashes as string[], fileNames: pending.map((a) => a.name), answer: full });
      }
    } catch (err) {
      // Deshace el turno para que el técnico pueda reintentar sin romper el historial.
      setState({
        ...prev,
        chat: [
          ...prev.chat,
          chatUser,
          { id: uid(), role: "assistant", error: true, text: `No he podido responder: ${err instanceof Error ? err.message : "error desconocido"}` },
        ],
      });
      setInput(text);
    } finally {
      setBusy(false);
      setStreamText("");
      setStreamStatus("");
    }
  }

  // Descarta la respuesta sacada del histórico y pregunta al agente de nuevo.
  async function askAgentAgain(item: ChatItem) {
    const s = stateRef.current;
    if (busy || s.chat[s.chat.length - 1]?.id !== item.id) return;
    const ids = new Set(item.downloadIds ?? []);
    const api = s.api.slice(0, -1);
    setState({ ...s, api, chat: s.chat.slice(0, -1), downloads: s.downloads.filter((d) => !ids.has(d.id)) });
    setBusy(true);
    setStreamText("");
    setStreamStatus("");
    try {
      const { full, turns } = await callAgent(api);
      applyAnswer(full, turns);
      const question = s.chat.find((m) => m.role === "user")?.text ?? "";
      const sent = s.attachments.filter((a) => a.sent);
      if (question && sent.every((a) => a.hash)) {
        saveToHistory({ question, files: sent.map((a) => a.hash!), fileNames: sent.map((a) => a.name), answer: full });
      }
    } catch (err) {
      setState({
        ...s,
        chat: [
          ...s.chat,
          { id: uid(), role: "assistant", error: true, text: `No he podido consultar al agente: ${err instanceof Error ? err.message : "error desconocido"}` },
        ],
      });
    } finally {
      setBusy(false);
      setStreamText("");
      setStreamStatus("");
    }
  }

  function newConsultation() {
    if (state.chat.length && !confirm("¿Empezar una consulta nueva? Se borrarán el chat, los adjuntos y los descargables.")) return;
    setState(EMPTY);
    setInput("");
    stopDictation();
    setTab("chat");
    setNewDownloads(0);
  }

  async function downloadPdf(ins: Instruction) {
    const { instructionPdf, pdfFileName } = await import("@/lib/pdf");
    instructionPdf(ins).save(pdfFileName(ins));
  }

  /* ---------- Acceso ---------- */

  // No se muestra nada de la app hasta saber si hace falta el código de acceso.
  if (!auth) return <div className="login" />;

  if (!auth.ok) {
    return (
      <LoginScreen
        onSubmit={async (code) => {
          const r = await fetch("/api/auth", { method: "POST", headers: { "x-access-code": code } });
          if (!r.ok) return false;
          try {
            localStorage.setItem(CODE_KEY, code);
          } catch {}
          setAuth({ required: true, code, ok: true });
          return true;
        }}
      />
    );
  }

  const uploading = state.attachments.some((a) => a.status === "uploading");
  const pendingCount = state.attachments.filter((a) => a.status === "ready" && !a.sent).length;
  const streamVisible = extractInstructions(streamText).visible;
  const writingInstruction = /<instruccion\b/.test(streamText) && !/<\/instruccion>/.test(streamText.split(/<instruccion\b/).pop() ?? "");

  /* ---------- Vistas ---------- */

  const lastId = state.chat[state.chat.length - 1]?.id;

  const chatView = (
    <section
      className="panel chat"
      aria-label="Chat"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
    >
      <div className="messages" ref={scrollRef}>
        {state.chat.length === 0 && !busy && (
          <div className="welcome">
            <Logo size="huge" />
            <h1>¿Qué le pasa a la máquina?</h1>
            <p>Cuéntame el síntoma y sube a Adjuntos los esquemas, el programa del PLC o fotos. Te ayudo a ordenar el diagnóstico.</p>
          </div>
        )}
        {state.chat.map((m) => {
          if (m.role === "assistant" && !m.error) {
            const html = renderMarkdown(m.text);
            const steps = html.includes("<li>");
            const previews = (m.downloadIds ?? [])
              .map((id) => state.downloads.find((d) => d.id === id))
              .filter((d): d is Instruction => !!d);
            return (
              <div key={m.id} className="msg assistant">
                <div className="answer">
                  {m.fromHistory && (
                    <div className="from-history">
                      {Icon.history}
                      <span>
                        Respuesta del histórico ({new Date(m.fromHistory).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })}), misma consulta con los mismos adjuntos.
                      </span>
                      {m.id === lastId && (
                        <button onClick={() => askAgentAgain(m)} disabled={busy}>
                          Consultar al agente igualmente
                        </button>
                      )}
                    </div>
                  )}
                  <div
                    className="bubble md"
                    onClick={steps ? (e) => toggleStep(m.id, e) : undefined}
                    dangerouslySetInnerHTML={{ __html: steps ? withSteps(html, m.checks) : html }}
                  />
                  {steps && <div className="steps-hint">Toca un paso: una vez revisado, dos descartado, tres lo desmarca.</div>}
                  {previews.map((d) => (
                    <PdfPreview key={d.id} ins={d} />
                  ))}
                </div>
              </div>
            );
          }
          return (
          <div key={m.id} className={`msg ${m.role}${m.error ? " error" : ""}`}>
            {m.role === "assistant" ? (
              <div className="bubble md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
            ) : (
              <div className="bubble">
                {m.text}
                {m.note && <div className="note">{Icon.clip} {m.note}</div>}
              </div>
            )}
          </div>
          );
        })}
        {busy && (
          <div className="msg assistant">
            <div className="bubble md">
              {streamVisible && <div dangerouslySetInnerHTML={{ __html: renderMarkdown(streamVisible) }} />}
              {(streamStatus || writingInstruction || !streamVisible) && (
                <div className="typing">
                  <span className="dots"><i /><i /><i /></span>
                  {streamStatus || (writingInstruction ? "Preparando la instrucción…" : "Pensando…")}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="composer">
        {pendingCount > 0 && (
          <div className="pending">
            {Icon.clip} {pendingCount} adjunto{pendingCount > 1 ? "s" : ""} nuevo{pendingCount > 1 ? "s" : ""} se enviará{pendingCount > 1 ? "n" : ""} con tu mensaje
          </div>
        )}
        {listening && (
          <div className="dictation">
            <span className="rec-dot" /> Escuchando… {interim && <em>{interim}</em>}
          </div>
        )}
        {micError && <div className="hint err">{micError}</div>}
        <div className="composer-row">
          <div className="attach">
            <button className={`icon-btn${attachMenu ? " on" : ""}`} title="Adjuntar" onClick={() => setAttachMenu((v) => !v)}>
              {Icon.clip}
            </button>
            {attachMenu && (
              <>
                <div className="menu-backdrop" onClick={() => setAttachMenu(false)} />
                <div className="attach-menu" role="menu">
                  <button className="only-mobile-flex" onClick={() => cameraRef.current?.click()}>
                    {Icon.camera} Hacer una foto
                  </button>
                  <button onClick={() => galleryRef.current?.click()}>
                    {Icon.image} Fotos de la galería o del equipo
                  </button>
                  <button onClick={() => fileRef.current?.click()}>
                    {Icon.doc} Documentos (PDF, programa, texto)
                  </button>
                </div>
              </>
            )}
          </div>
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            placeholder={listening ? "Habla, o escribe a la vez…" : "Describe la avería o lo que has comprobado…"}
            onChange={(e) => setInput(e.target.value)}
            onPaste={pasteFiles}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(min-width: 900px)").matches) {
                e.preventDefault();
                send();
              }
            }}
          />
          {speechOk && (
            <button
              className={`icon-btn mic${listening ? " recording" : ""}`}
              title={listening ? "Parar el dictado" : "Dictar por voz"}
              aria-pressed={listening}
              onClick={toggleDictation}
            >
              {Icon.mic}
            </button>
          )}
          <button
            className="send-btn"
            title="Enviar"
            disabled={busy || uploading || (!input.trim() && pendingCount === 0)}
            onClick={send}
          >
            {Icon.send}
          </button>
        </div>
        {uploading && <div className="hint">Esperando a que terminen de subir los adjuntos…</div>}
      </div>
    </section>
  );

  const attachmentsView = (
    <section className="panel side" aria-label="Adjuntos">
      <div className="panel-head">
        <h2>Adjuntos</h2>
        <span className="count">{state.attachments.length}</span>
      </div>
      <div className="dropzone" onClick={() => fileRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
      >
        <div className="drop-icon">{Icon.plus}</div>
        <div>
          <strong>Subir documentación</strong>
          <span>Esquemas, planos, programa del PLC, manuales o fotos</span>
        </div>
      </div>
      <div className="photo-btns">
        <button className="secondary-btn only-mobile" onClick={() => cameraRef.current?.click()}>
          {Icon.camera} Hacer una foto
        </button>
        <button className="secondary-btn" onClick={() => galleryRef.current?.click()}>
          {Icon.image} Fotos de la galería
        </button>
      </div>
      <ul className="list">
        {state.attachments.length === 0 && <li className="empty">Aún no hay documentación.</li>}
        {state.attachments.map((a) => (
          <li key={a.id} className={`item ${a.status}`}>
            <div className="thumb">
              {a.thumb ? <img src={a.thumb} alt="" /> : a.kind === "text" ? Icon.code : Icon.doc}
            </div>
            <div className="item-body">
              <div className="item-title" title={a.name}>{a.name}</div>
              <div className="item-meta">
                {a.status === "uploading" && "Subiendo…"}
                {a.status === "error" && <span className="err">{a.error}</span>}
                {a.status === "ready" && (
                  <>
                    {formatSize(a.size)} · {a.sent ? "El agente ya lo tiene" : "Se enviará con tu próximo mensaje"}
                  </>
                )}
              </div>
            </div>
            <button className="icon-btn small" title="Quitar" onClick={() => removeAttachment(a)}>
              {Icon.trash}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );

  const downloadsView = (
    <section className="panel side" aria-label="Descargables">
      <div className="panel-head">
        <h2>Descargables</h2>
        <span className="count">{state.downloads.length}</span>
      </div>
      <ul className="list">
        {state.downloads.length === 0 && (
          <li className="empty">Cuando el agente prepare una instrucción de trabajo, aparecerá aquí para descargarla en PDF.</li>
        )}
        {state.downloads.map((d) => (
          <li key={d.id} className="item download">
            <div className="item-row">
              <div className="thumb pdf">PDF</div>
              <div className="item-body">
                <div className="item-title" title={d.title}>{d.title}</div>
                <div className="item-meta">{new Date(d.createdAt).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })}</div>
              </div>
            </div>
            <div className="item-actions">
              <button className="secondary-btn" onClick={() => setOpenInstruction(openInstruction === d.id ? null : d.id)}>
                {openInstruction === d.id ? "Ocultar" : "Ver"}
              </button>
              <button className="primary-btn" onClick={() => downloadPdf(d)}>
                {Icon.download} Descargar PDF
              </button>
            </div>
            {openInstruction === d.id && (
              <div className="preview md" dangerouslySetInnerHTML={{ __html: renderMarkdown(d.markdown) }} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo dark />
          <div>
            <div className="brand-name">PLC<span>Doctor</span></div>
            <div className="brand-sub"><i className="led" /> Asistente de diagnóstico de averías</div>
          </div>
        </div>
        <button className="ghost-btn" onClick={newConsultation} disabled={busy}>
          {Icon.plus} <span>Nueva consulta</span>
        </button>
      </header>

      <main className={`layout tab-${tab}`}>
        {chatView}
        <div className="sidebar">
          {attachmentsView}
          {downloadsView}
        </div>
      </main>

      <nav className="tabbar">
        <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>
          {Icon.chat}
          <span>Chat</span>
        </button>
        <button className={tab === "adjuntos" ? "active" : ""} onClick={() => setTab("adjuntos")}>
          {Icon.clip}
          <span>Adjuntos</span>
          {state.attachments.length > 0 && <em>{state.attachments.length}</em>}
        </button>
        <button className={tab === "descargables" ? "active" : ""} onClick={() => setTab("descargables")}>
          {Icon.download}
          <span>Descargables</span>
          {newDownloads > 0 && <em className="new">{newDownloads}</em>}
        </button>
      </nav>

      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        accept=".pdf,image/*,.scl,.xml,.st,.awl,.csv,.txt,.md,.log,.json,.udt,.db"
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={galleryRef}
        type="file"
        multiple
        hidden
        accept="image/*"
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function LoginScreen({ onSubmit }: { onSubmit: (code: string) => Promise<boolean> }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);
  return (
    <div className="login">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(!(await onSubmit(code.trim())));
        }}
      >
        <Logo size="big" />
        <h1>PLCDoctor</h1>
        <p>Introduce el código de acceso</p>
        <input type="password" value={code} onChange={(e) => setCode(e.target.value)} autoFocus placeholder="Código" />
        {error && <div className="err">Código incorrecto</div>}
        <button className="primary-btn" type="submit">Entrar</button>
      </form>
    </div>
  );
}
