// Detecta las instrucciones de trabajo que el agente escribe entre etiquetas
// <instruccion titulo="..."> ... </instruccion> y las separa del texto del chat.

export interface Instruction {
  id: string;
  title: string;
  markdown: string;
  createdAt: number;
}

const BLOCK = /<instruccion(?:\s+titulo\s*=\s*"([^"]*)")?\s*>([\s\S]*?)<\/instruccion>/g;

export function extractInstructions(text: string): { visible: string; found: { title: string; markdown: string }[] } {
  const found: { title: string; markdown: string }[] = [];
  let visible = text.replace(BLOCK, (_, title: string | undefined, body: string) => {
    found.push({ title: (title || "Instrucción de trabajo").trim(), markdown: body.trim() });
    return "";
  });
  // Mientras llega por streaming, oculta una instrucción que aún no se ha cerrado.
  const open = visible.search(/<instruccion\b/);
  if (open !== -1) visible = visible.slice(0, open);
  // Oculta también un "<instr" a medio escribir al final del texto.
  visible = visible.replace(/<[a-z]{0,11}$/i, (m) => ("<instruccion".startsWith(m.toLowerCase()) ? "" : m));
  // Quita bloques de código vacíos que envolvían la instrucción.
  visible = visible.replace(/```[a-z]*\s*```/g, "");
  return { visible: visible.replace(/\n{3,}/g, "\n\n").trim(), found };
}
