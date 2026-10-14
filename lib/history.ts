// Histórico de consultas resueltas, guardado en el navegador (localStorage).
// Una respuesta solo se reutiliza si la pregunta va con exactamente los mismos
// adjuntos (planos, programa, fotos), comparados por la huella SHA-256 de su contenido.

export interface HistoryEntry {
  id: string;
  question: string;
  norm: string;
  files: string[];
  fileNames: string[];
  answer: string;
  createdAt: number;
}

const KEY = "plcdoctor-historico";
const MAX_ENTRIES = 60;
const MAX_CANDIDATES = 15;

export function normalize(q: string): string {
  return q
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9%.,]+/g, " ")
    .replace(/[.,](\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fileHash(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function sameFiles(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((h, i) => h === sb[i]);
}

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveToHistory(entry: Omit<HistoryEntry, "id" | "norm" | "createdAt">) {
  const norm = normalize(entry.question);
  const rest = loadHistory().filter((e) => !(e.norm === norm && sameFiles(e.files, entry.files)));
  const next: HistoryEntry = { ...entry, id: Math.random().toString(36).slice(2, 10), norm, createdAt: Date.now() };
  try {
    localStorage.setItem(KEY, JSON.stringify([next, ...rest].slice(0, MAX_ENTRIES)));
  } catch {}
}

export function findExact(question: string, files: string[]): HistoryEntry | null {
  const norm = normalize(question);
  return loadHistory().find((e) => e.norm === norm && sameFiles(e.files, files)) ?? null;
}

// Consultas anteriores hechas con los mismos adjuntos: las únicas que se pueden reutilizar.
export function candidatesFor(files: string[]): HistoryEntry[] {
  return loadHistory()
    .filter((e) => sameFiles(e.files, files))
    .slice(0, MAX_CANDIDATES);
}
