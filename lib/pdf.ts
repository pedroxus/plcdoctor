import { jsPDF } from "jspdf";
import { marked, type Token, type Tokens } from "marked";
import type { Instruction } from "./instructions";
import { LOGO_PNG } from "./logoPdf";

// Helvetica de jsPDF solo cubre Latin-1: sustituye los símbolos habituales que no entran.
function clean(s: string): string {
  return s
    .replace(/[→⇒]/g, "->")
    .replace(/[←]/g, "<-")
    .replace(/≥/g, ">=")
    .replace(/≤/g, "<=")
    .replace(/≈/g, "~")
    .replace(/[–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, "...")
    .replace(/[✓✔]/g, "OK")
    .replace(/[⚠]/g, "(!)")
    .replace(/Ω/g, "ohm")
    .replace(/[^\u0000-ÿ]/g, "");
}

function inline(tokens: Token[] | undefined, raw: string): string {
  if (!tokens) return clean(raw);
  return clean(
    tokens
      .map((t) => {
        if ("tokens" in t && t.tokens) return inline(t.tokens, "");
        if (t.type === "br") return "\n";
        return "text" in t ? String(t.text) : t.raw;
      })
      .join(""),
  )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const BLUE: [number, number, number] = [11, 79, 156];

export function instructionPdf(ins: Instruction): jsPDF {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210;
  const M = 18;
  const maxW = W - 2 * M;
  let y = 0;

  const header = () => {
    doc.setFillColor(...BLUE);
    doc.rect(0, 0, W, 18, "F");
    // Logo arriba a la izquierda: robot azul sobre un recuadro blanco.
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(M, 2.5, 13, 13, 1.5, 1.5, "F");
    doc.addImage(LOGO_PNG, "PNG", M + 0.75, 3.25, 11.5, 11.5, "logo", "FAST");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("PLCDoctor", M + 17, 11.5);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text("Instrucción de trabajo", W - M, 11.5, { align: "right" });
    doc.setTextColor(30, 30, 30);
    y = 28;
  };

  const ensure = (h: number) => {
    if (y + h > 285) {
      doc.addPage();
      header();
    }
  };

  const write = (text: string, opts: { size?: number; bold?: boolean; indent?: number; gap?: number; color?: [number, number, number] } = {}) => {
    const size = opts.size ?? 10.5;
    const indent = opts.indent ?? 0;
    doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(...(opts.color ?? [30, 30, 30]));
    const lines = doc.splitTextToSize(text, maxW - indent) as string[];
    const lh = size * 0.45;
    for (const line of lines) {
      ensure(lh);
      doc.text(line, M + indent, y);
      y += lh;
    }
    y += opts.gap ?? 2;
  };

  header();
  write(clean(ins.title), { size: 16, bold: true, color: BLUE, gap: 1 });
  write(`Generada el ${new Date(ins.createdAt).toLocaleString("es-ES")}`, { size: 8.5, color: [110, 110, 110], gap: 5 });

  const renderList = (list: Tokens.List, depth: number) => {
    list.items.forEach((item, i) => {
      const bullet = list.ordered ? `${(Number(list.start) || 1) + i}.` : "•";
      const textTokens = item.tokens.filter((t) => t.type !== "list");
      const text = textTokens.map((t) => inline("tokens" in t ? t.tokens : undefined, t.raw)).join(" ").trim();
      const indent = depth * 6;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10.5);
      doc.setTextColor(30, 30, 30);
      ensure(5);
      doc.text(bullet, M + indent, y);
      write(text, { indent: indent + 7, gap: 1.2 });
      item.tokens.filter((t): t is Tokens.List => t.type === "list").forEach((sub) => renderList(sub, depth + 1));
    });
  };

  for (const tok of marked.lexer(ins.markdown)) {
    switch (tok.type) {
      case "heading": {
        const t = tok as Tokens.Heading;
        y += 2;
        write(inline(t.tokens, t.text), { size: t.depth <= 2 ? 13 : 11.5, bold: true, color: BLUE, gap: 2 });
        break;
      }
      case "paragraph": {
        const t = tok as Tokens.Paragraph;
        write(inline(t.tokens, t.text), { gap: 3 });
        break;
      }
      case "list":
        renderList(tok as Tokens.List, 0);
        y += 2;
        break;
      case "table": {
        const t = tok as Tokens.Table;
        const rows = [t.header, ...t.rows];
        rows.forEach((row, ri) => {
          write(row.map((c) => inline(c.tokens, c.text)).join("  |  "), { bold: ri === 0, size: 9.5, gap: 1 });
        });
        y += 2;
        break;
      }
      case "blockquote": {
        const t = tok as Tokens.Blockquote;
        write(clean(t.text), { indent: 4, color: [80, 80, 80], gap: 3 });
        break;
      }
      case "code": {
        const t = tok as Tokens.Code;
        doc.setFont("courier", "normal");
        write(clean(t.text), { size: 9, gap: 3 });
        break;
      }
      case "hr":
        ensure(4);
        doc.setDrawColor(200, 200, 200);
        doc.line(M, y, W - M, y);
        y += 4;
        break;
      case "space":
        break;
      default:
        if ("text" in tok) write(clean(String(tok.text)), { gap: 3 });
    }
  }

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(130, 130, 130);
    doc.text("Instrucción generada por un asistente de IA. Compruébala antes de intervenir en la máquina.", M, 292);
    doc.text(`${p}/${pages}`, W - M, 292, { align: "right" });
  }
  return doc;
}

export function pdfFileName(ins: Instruction): string {
  const slug = ins.title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);
  return `${slug || "instruccion"}.pdf`;
}
