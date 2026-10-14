"use client";

import { useEffect, useRef, useState } from "react";
import type { Instruction } from "@/lib/instructions";

// Vista previa del PDF de una instrucción dentro del chat: se genera el mismo PDF que
// se descarga y se dibuja página a página con pdf.js, en un recuadro con scroll y zoom.
export default function PdfPreview({ ins }: { ins: Instruction }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [full, setFull] = useState(false);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ instructionPdf }, pdfjs] = await Promise.all([import("@/lib/pdf"), import("pdfjs-dist/legacy/build/pdf.mjs")]);
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
        const data = instructionPdf(ins).output("arraybuffer");
        const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
        const box = boxRef.current;
        const holder = pagesRef.current;
        if (cancelled || !box || !holder) return;
        const width = (box.clientWidth - 24) * zoom;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const canvases: HTMLCanvasElement[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / base.width) * ratio });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.floor(width)}px`;
          await page.render({ canvas, viewport }).promise;
          canvases.push(canvas);
          if (cancelled) return;
        }
        holder.replaceChildren(...canvases);
        setPages(doc.numPages);
        doc.destroy();
      } catch (err) {
        console.error(err);
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ins, zoom, full]);

  return (
    <div className={`pdf-preview${full ? " full" : ""}`}>
      <div className="pdf-bar">
        <span className="pdf-tag">PDF</span>
        <span className="pdf-title" title={ins.title}>{ins.title}</span>
        {pages > 0 && <span className="pdf-pages">{pages} pág.</span>}
        <button title="Alejar" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(1)))} disabled={zoom <= 0.6}>−</button>
        <button title="Acercar" onClick={() => setZoom((z) => Math.min(2.4, +(z + 0.2).toFixed(1)))} disabled={zoom >= 2.4}>+</button>
        <button title={full ? "Cerrar pantalla completa" : "Pantalla completa"} onClick={() => setFull((f) => !f)}>
          {full ? "✕" : "⤢"}
        </button>
      </div>
      <div className="pdf-pages-box" ref={boxRef}>
        {error ? (
          <div className="pdf-msg">No se ha podido mostrar la vista previa. Puedes descargarlo en Descargables.</div>
        ) : (
          <>
            {pages === 0 && <div className="pdf-msg">Generando vista previa…</div>}
            <div className="pdf-canvas" ref={pagesRef} />
          </>
        )}
      </div>
      <div className="pdf-foot">La descarga está en Descargables.</div>
    </div>
  );
}
