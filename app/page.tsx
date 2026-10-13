"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { marked } from "marked";
import { extractInstructions, type Instruction } from "@/lib/instructions";

/* ---------- Tipos ---------- */

type ApiBlock = Record<string, unknown>;
interface ApiMessage {
  role: "user" | "assistant";
  content: ApiBlock[];
}

interface ChatItem {
  id: string;
  role: "user" | "assistant";
  text: string;
  note?: string;
  error?: boolean;
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
  text?: string;
  thumb?: string;
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
const STORAGE_KEY = "plcdoctor-consulta-v1";
const CODE_KEY = "plcdoctor-codigo";
const TEXT_EXT = ["scl", "xml", "st", "awl", "csv", "txt", "md", "log", "json", "udt", "db"];
const MAX_UPLOAD = 4 * 1024 * 1024;

const uid = () => Math.random().toString(36).slice(2, 10);

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
  if (a.kind === "pdf") {
    return [{ type: "document", title: a.name, source: { type: "file", file_id: a.fileId } }];
  }
  return [
    { type: "text", text: `Foto adjunta: ${a.name}` },
    { type: "image", source: { type: "file", file_id: a.fileId } },
  ];
}

/* ---------- Iconos ---------- */

const Icon = {
  chat: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 4V5z" /></svg>
  ),
  clip: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 12.5l6.5-6.5a3 3 0 014.2 4.2l-8.1 8.1a5 5 0 01-7-7L11 4" /></svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14" /></svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-8-6 16-2.5-6.5L4 12z" /></svg>
  ),
  camera: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-2.5h6L17 8h3v11H4V8z" /><circle cx="12" cy="13" r="3.5" /></svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" /></svg>
  ),
  doc: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6V3z" /><path d="M14 3v4h4" /></svg>
  ),
  code: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6V3z" /><path d="M10 12l-2 2 2 2M14 12l2 2-2 2" /></svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
  ),
};

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

  const stateRef = useRef(state);
  stateRef.current = state;
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* Carga inicial: conversación guardada y control de acceso */
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const s = JSON.parse(saved) as State;
        s.attachments = s.attachments.filter((a) => a.status === "ready");
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {}
  }, [state, loaded]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [state.chat.length, streamText, streamStatus, tab]);

  useEffect(() => {
    if (tab === "descargables") setNewDownloads(0);
  }, [tab]);

  const headers = useCallback((): Record<string, string> => (auth?.code ? { "x-access-code": auth.code } : {}), [auth]);

  const patchAttachment = (id: string, patch: Partial<Attachment>) =>
    setState((s) => ({ ...s, attachments: s.attachments.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));

  /* ---------- Adjuntos ---------- */

  async function addFiles(files: FileList | null) {
    if (!files) return;
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
        if (kind === "text") {
          if (file.size > 1024 * 1024) throw new Error("El archivo de texto supera 1 MB");
          patchAttachment(id, { text: await file.text(), status: "ready" });
          continue;
        }
        let blob: Blob = file;
        let name = file.name;
        if (kind === "image") {
          blob = await shrinkImage(file, 2000);
          name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
          const thumb = await blobToDataUrl(await shrinkImage(file, 160, 0.7));
          patchAttachment(id, { thumb, name, size: blob.size });
        }
        if (blob.size > MAX_UPLOAD) throw new Error(`Supera el máximo de ${formatSize(MAX_UPLOAD)}`);
        const form = new FormData();
        form.append("file", new File([blob], name, { type: kind === "pdf" ? "application/pdf" : "image/jpeg" }));
        const res = await fetch("/api/upload", { method: "POST", body: form, headers: headers() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Error al subir");
        patchAttachment(id, { fileId: data.id, status: "ready" });
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

  /* ---------- Chat ---------- */

  async function send() {
    const s = stateRef.current;
    const text = input.trim();
    const pending = s.attachments.filter((a) => a.status === "ready" && !a.sent);
    if (busy || (!text && pending.length === 0)) return;
    if (s.attachments.some((a) => a.status === "uploading")) return;

    const notes: string[] = [];
    if (pending.length) notes.push(`[El técnico ha subido a Adjuntos: ${pending.map((a) => a.name).join(", ")}]`);
    if (s.removed.length) notes.push(`[El técnico ha quitado de Adjuntos: ${s.removed.join(", ")}]`);
    const userText = text || "He subido documentación nueva a Adjuntos.";

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

    setState({
      ...s,
      api,
      chat: [...s.chat, chatUser],
      removed: [],
      attachments: s.attachments.map((a) => (pendingIds.has(a.id) ? { ...a, sent: true } : a)),
    });
    setInput("");
    setBusy(true);
    setStreamText("");
    setStreamStatus("");

    try {
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

      const { visible, found } = extractInstructions(full);
      const now = Date.now();
      const newIns: Instruction[] = found.map((f, i) => ({ id: uid(), title: f.title, markdown: f.markdown, createdAt: now + i }));
      setState((cur) => ({
        ...cur,
        api: [...cur.api, ...turns!.map((content) => ({ role: "assistant" as const, content }))],
        chat: [...cur.chat, { id: uid(), role: "assistant", text: visible || (newIns.length ? "Instrucción creada." : "(sin respuesta)") }],
        downloads: [...newIns, ...cur.downloads],
      }));
      if (newIns.length) setNewDownloads((n) => n + newIns.length);
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

  function newConsultation() {
    if (state.chat.length && !confirm("¿Empezar una consulta nueva? Se borrarán el chat, los adjuntos y los descargables.")) return;
    setState(EMPTY);
    setTab("chat");
    setNewDownloads(0);
  }

  async function downloadPdf(ins: Instruction) {
    const { instructionPdf, pdfFileName } = await import("@/lib/pdf");
    instructionPdf(ins).save(pdfFileName(ins));
  }

  /* ---------- Acceso ---------- */

  if (auth && !auth.ok) {
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

  const chatView = (
    <section className="panel chat" aria-label="Chat">
      <div className="messages" ref={scrollRef}>
        {state.chat.length === 0 && !busy && (
          <div className="welcome">
            <div className="welcome-badge">PLC</div>
            <h1>¿Qué le pasa a la máquina?</h1>
            <p>Cuéntame el síntoma y sube a Adjuntos los esquemas, el programa del PLC o fotos. Te ayudo a ordenar el diagnóstico.</p>
          </div>
        )}
        {state.chat.map((m) => (
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
        ))}
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
        <div className="composer-row">
          <button className="icon-btn" title="Adjuntar archivo" onClick={() => fileRef.current?.click()}>
            {Icon.clip}
          </button>
          <button className="icon-btn only-mobile" title="Hacer foto" onClick={() => cameraRef.current?.click()}>
            {Icon.camera}
          </button>
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            placeholder="Describe la avería o lo que has comprobado…"
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(min-width: 900px)").matches) {
                e.preventDefault();
                send();
              }
            }}
          />
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
      <button className="secondary-btn only-mobile" onClick={() => cameraRef.current?.click()}>
        {Icon.camera} Hacer una foto
      </button>
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
          <div className="logo">PLC</div>
          <div>
            <div className="brand-name">PLCDoctor</div>
            <div className="brand-sub">Asistente de diagnóstico de averías</div>
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
        <div className="logo big">PLC</div>
        <h1>PLCDoctor</h1>
        <p>Introduce el código de acceso</p>
        <input type="password" value={code} onChange={(e) => setCode(e.target.value)} autoFocus placeholder="Código" />
        {error && <div className="err">Código incorrecto</div>}
        <button className="primary-btn" type="submit">Entrar</button>
      </form>
    </div>
  );
}
